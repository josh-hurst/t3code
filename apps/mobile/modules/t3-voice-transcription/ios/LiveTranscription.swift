import AVFoundation
import ExpoModulesCore
import Speech

/// Feeds a recording's buffers to SpeechAnalyzer as they arrive, so only the tail is left
/// to recognize when recording stops. The locale's assets were installed during prepare.
@available(iOS 26, *)
enum LiveTranscription {
  static func run(
    _ buffers: AsyncStream<AVAudioPCMBuffer>,
    locale: String,
    onPreview: @escaping @Sendable (_ committed: String, _ tentative: String) -> Void
  ) async throws -> String {
    let transcriber = SpeechTranscriber(
      locale: Locale(identifier: locale),
      preset: .progressiveTranscription
    )
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber])
    else { throw LiveTranscriptionException("No audio format is available for this language.") }
    let (inputs, input) = AsyncStream.makeStream(of: AnalyzerInput.self)
    let results = Task {
      var text: [String] = []
      for try await result in transcriber.results {
        let phrase = String(result.text.characters)
        if result.isFinal {
          text.append(phrase)
          onPreview(normalized(text), "")
        } else {
          onPreview(normalized(text), normalized([phrase]))
        }
      }
      return text
    }
    do {
      try await analyzer.start(inputSequence: inputs)
      var converter: AVAudioConverter?
      for await buffer in buffers {
        try Task.checkCancellation()
        if converter?.inputFormat != buffer.format {
          converter = AVAudioConverter(from: buffer.format, to: format)
        }
        guard let converter else { throw LiveTranscriptionException("The recording could not be converted.") }
        input.yield(AnalyzerInput(buffer: try convert(buffer, with: converter)))
      }
      try Task.checkCancellation()
      input.finish()
      try await analyzer.finalizeAndFinishThroughEndOfInput()
      return normalized(try await results.value)
    } catch {
      input.finish()
      results.cancel()
      await analyzer.cancelAndFinishNow()
      throw error
    }
  }

  private static func normalized(_ phrases: [String]) -> String {
    phrases.joined(separator: " ").split(whereSeparator: \.isWhitespace).joined(separator: " ")
  }

  private static func convert(
    _ buffer: AVAudioPCMBuffer,
    with converter: AVAudioConverter
  ) throws -> AVAudioPCMBuffer {
    let format = converter.outputFormat
    let ratio = format.sampleRate / buffer.format.sampleRate
    let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 1
    guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else {
      throw LiveTranscriptionException("The recording could not be converted.")
    }
    var consumed = false
    var failure: NSError?
    let status = converter.convert(to: output, error: &failure) { _, state in
      if consumed {
        state.pointee = .noDataNow
        return nil
      }
      consumed = true
      state.pointee = .haveData
      return buffer
    }
    if status == .error {
      throw failure ?? LiveTranscriptionException("The recording could not be converted.")
    }
    return output
  }
}

final class LiveTranscriptionException: GenericException<String>, @unchecked Sendable {
  override var reason: String { param }
}
