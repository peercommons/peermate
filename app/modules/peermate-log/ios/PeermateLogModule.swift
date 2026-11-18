import ExpoModulesCore
import os

// Writes app log lines to the unified log (subsystem com.peermate.app), where
// they're kept even in Release builds and can be collected off the device later
// (app/tools/ios-log.sh). Notice level, because info isn't persisted.
public class PeermateLogModule: Module {
  private static let logger = Logger(subsystem: "com.peermate.app", category: "app")

  public func definition() -> ModuleDefinition {
    Name("PeermateLog")

    Function("log") { (message: String) in
      Self.logger.notice("\(message, privacy: .public)")
    }
  }
}
