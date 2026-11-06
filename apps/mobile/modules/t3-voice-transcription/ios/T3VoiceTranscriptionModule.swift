import AVFoundation
import AudioToolbox
import ExpoModulesCore
import Foundation

public class T3VoiceTranscriptionModule: Module {
  private let lock = NSLock()
  private var recorders: [String: LiveVoiceRecorder] = [:]
  private var operations: [Int: Task<String, Error>] = [:]

  public func definition() -> ModuleDefinition {
    Name("T3VoiceTranscription")

    Class(LiveVoiceRecorder.self) {
      Constructor { () -> LiveVoiceRecorder in
        let recorder = LiveVoiceRecorder()
        // The module outlives its recorders, so the strong capture cannot leak.
        recorder.onRelease = { id in
          self.lock.withLock { _ = self.recorders.removeValue(forKey: id) }
        }
        self.lock.withLock { self.recorders[recorder.id] = recorder }
        return recorder
      }
      Property("uri") { (recorder: LiveVoiceRecorder) in recorder.url?.absoluteString }
      AsyncFunction("prepareToRecordAsync") { (recorder: LiveVoiceRecorder) in try recorder.prepare() }
      Function("record") { (recorder: LiveVoiceRecorder, options: [String: Double]) in
        try recorder.record(forDuration: options["forDuration"] ?? 300)
      }
      AsyncFunction("stop") { (recorder: LiveVoiceRecorder) in recorder.stop() }
      Function("getStatus") { (recorder: LiveVoiceRecorder) in recorder.status() }
      Function("getAvailableInputs") { (_: LiveVoiceRecorder) -> [[String: Any]] in
        AVAudioSession.sharedInstance().availableInputs?.map {
          ["name": $0.portName, "type": $0.portType.rawValue, "uid": $0.uid]
        } ?? []
      }
      Function("setInput") { (_: LiveVoiceRecorder, uid: String) in
        let session = AVAudioSession.sharedInstance()
        guard let input = session.availableInputs?.first(where: { $0.uid == uid }) else {
          throw LiveTranscriptionException("The preferred microphone is disconnected.")
        }
        try session.setPreferredInput(input)
      }
    }

    AsyncFunction("startLive") { (id: Int, uri: String, locale: String) async throws -> String in
      guard #available(iOS 26, *) else {
        throw LiveTranscriptionException("Live dictation requires iOS 26 or later.")
      }
      guard let buffers = self.lock.withLock({ self.recorders.values.first { $0.url?.absoluteString == uri } })?
        .takeBuffers()
      else { throw LiveTranscriptionException("The voice recording is no longer available.") }
      let task = Task { try await LiveTranscription.run(buffers, locale: locale) }
      self.lock.withLock { self.operations[id] = task }
      defer { self.lock.withLock { _ = self.operations.removeValue(forKey: id) } }
      return try await task.value
    }

    AsyncFunction("cancel") { (id: Int) async in
      let task = self.lock.withLock { self.operations[id] }
      task?.cancel()
      _ = await task?.result
    }

    AsyncFunction("decodeRecording") { (uri: URL) throws -> Data in
      guard uri.isFileURL else { throw CocoaError(.fileReadUnsupportedScheme) }
      var opened: ExtAudioFileRef?
      try check(ExtAudioFileOpenURL(uri as CFURL, &opened))
      guard let file = opened else { throw CocoaError(.fileReadCorruptFile) }
      defer { ExtAudioFileDispose(file) }
      var format = AudioStreamBasicDescription(
        mSampleRate: 16_000, mFormatID: kAudioFormatLinearPCM,
        mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
        mBytesPerPacket: 2, mFramesPerPacket: 1, mBytesPerFrame: 2,
        mChannelsPerFrame: 1, mBitsPerChannel: 16, mReserved: 0)
      let formatSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
      try check(ExtAudioFileSetProperty(file, kExtAudioFileProperty_ClientDataFormat, formatSize, &format))
      var pcm = Data()
      var chunk = [Int16](repeating: 0, count: 8192)
      try chunk.withUnsafeMutableBytes { bytes in
        while true {
          var frames = UInt32(bytes.count / 2)
          var buffers = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(
            mNumberChannels: 1, mDataByteSize: UInt32(bytes.count), mData: bytes.baseAddress))
          try check(ExtAudioFileRead(file, &frames, &buffers))
          if frames == 0 { break }
          let count = Int(frames) * 2
          guard pcm.count + count <= 16_000 * 2 * 301 else { throw CocoaError(.fileReadTooLarge) }
          pcm.append(contentsOf: bytes.prefix(count))
        }
      }
      guard !pcm.isEmpty else { throw CocoaError(.fileReadCorruptFile) }
      return pcm
    }
  }
}

private func check(_ status: OSStatus) throws {
  guard status == noErr else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
}
