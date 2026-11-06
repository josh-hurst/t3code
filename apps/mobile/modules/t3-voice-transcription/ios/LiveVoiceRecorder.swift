import AVFoundation
import ExpoModulesCore
import Foundation

/// Records the microphone like expo-audio's recorder while handing each buffer to live
/// transcription. The app's audio session is configured for recording before `prepare`.
final class LiveVoiceRecorder: SharedObject {
  let id = UUID().uuidString
  private let engine = AVAudioEngine()
  private let lock = NSLock()
  private var file: AVAudioFile?
  private var buffers: AsyncStream<AVAudioPCMBuffer>.Continuation?
  private var pending: AsyncStream<AVAudioPCMBuffer>?
  private var frames: AVAudioFramePosition = 0
  private var sampleRate: Double = 0
  private var metering: Float = -160
  private var recording = false
  private var limit: DispatchWorkItem?
  private(set) var url: URL?
  var onRelease: ((String) -> Void)?

  func prepare() throws {
    if lock.withLock({ recording }) { throw RecordingActiveException() }
    stopEngine()
    let (stream, continuation) = AsyncStream.makeStream(of: AVAudioPCMBuffer.self)
    lock.withLock {
      buffers?.finish()
      buffers = continuation
      pending = stream
      frames = 0
      metering = -160
      url = FileManager.default.temporaryDirectory
        .appendingPathComponent("dictation-live-\(UUID().uuidString).caf")
    }
    engine.prepare()
  }

  /// The buffers captured since `prepare`, for exactly one consumer.
  func takeBuffers() -> AsyncStream<AVAudioPCMBuffer>? {
    lock.withLock {
      defer { pending = nil }
      return pending
    }
  }

  func record(forDuration seconds: Double) throws {
    guard let url = lock.withLock({ url }) else { throw RecorderNotPreparedException() }
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else { throw MicrophoneUnavailableException() }
    let output = try AVAudioFile(
      forWriting: url,
      settings: format.settings,
      commonFormat: format.commonFormat,
      interleaved: format.isInterleaved
    )
    lock.withLock {
      file = output
      sampleRate = format.sampleRate
    }
    input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
      self?.capture(buffer)
    }
    do {
      try engine.start()
    } catch {
      input.removeTap(onBus: 0)
      throw error
    }
    lock.withLock { recording = true }
    let timer = DispatchWorkItem { [weak self] in self?.finish(error: nil) }
    limit = timer
    DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: timer)
  }

  func stop() {
    finish(error: nil)
  }

  func status() -> [String: Any] {
    lock.withLock {
      [
        "canRecord": url != nil,
        "isRecording": recording,
        "durationMillis": sampleRate > 0 ? Double(frames) / sampleRate * 1000 : 0,
        "metering": metering,
        "mediaServicesDidReset": false,
        "url": url?.absoluteString as Any
      ]
    }
  }

  private func capture(_ buffer: AVAudioPCMBuffer) {
    guard let copy = buffer.copied() else { return }
    let power = buffer.averagePower()
    let (output, stream) = lock.withLock { () -> (AVAudioFile?, AsyncStream<AVAudioPCMBuffer>.Continuation?) in
      guard recording else { return (nil, nil) }
      frames += AVAudioFramePosition(buffer.frameLength)
      metering = power
      return (file, buffers)
    }
    try? output?.write(from: buffer)
    stream?.yield(copy)
  }

  private func finish(error: Error?) {
    let finished = lock.withLock { () -> URL? in
      guard recording else { return nil }
      recording = false
      return url
    }
    stopEngine()
    guard let finished else { return }
    emit(event: "recordingStatusUpdate", payload: [
      "id": id,
      "isFinished": true,
      "hasError": error != nil,
      "error": error?.localizedDescription as Any,
      "url": finished.absoluteString
    ] as [String: Any])
  }

  private func stopEngine() {
    limit?.cancel()
    limit = nil
    if engine.isRunning { engine.stop() }
    engine.inputNode.removeTap(onBus: 0)
    lock.withLock {
      recording = false
      file = nil
      buffers?.finish()
      buffers = nil
    }
  }

  override func sharedObjectDidRelease() {
    super.sharedObjectDidRelease()
    stopEngine()
    onRelease?(id)
  }
}

final class RecordingActiveException: Exception, @unchecked Sendable {
  override var reason: String { "Another voice recording is active." }
}

final class RecorderNotPreparedException: Exception, @unchecked Sendable {
  override var reason: String { "The microphone is not prepared." }
}

final class MicrophoneUnavailableException: Exception, @unchecked Sendable {
  override var reason: String { "The microphone is unavailable." }
}

extension AVAudioPCMBuffer {
  /// Tap buffers are reused by the engine, so anything kept past the callback is a copy.
  func copied() -> AVAudioPCMBuffer? {
    guard let copy = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameLength) else { return nil }
    copy.frameLength = frameLength
    let source = UnsafeMutableAudioBufferListPointer(mutableAudioBufferList)
    let target = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
    for (from, to) in zip(source, target) {
      guard let data = from.mData, let destination = to.mData else { continue }
      memcpy(destination, data, Int(min(from.mDataByteSize, to.mDataByteSize)))
    }
    return copy
  }

  func averagePower() -> Float {
    guard let channel = floatChannelData?[0], frameLength > 0 else { return -160 }
    var sum: Float = 0
    for index in 0..<Int(frameLength) { sum += channel[index] * channel[index] }
    let rms = (sum / Float(frameLength)).squareRoot()
    return rms > 0 ? max(-160, 20 * log10(rms)) : -160
  }
}
