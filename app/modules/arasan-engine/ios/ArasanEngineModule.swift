import ExpoModulesCore

// Same interface as the Android module (child process there, in process here).
public class ArasanEngineModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ArasanEngine")

    Events("onLine")

    // Starts the engine (if needed). Resolves with the network's file path, which
    // the caller passes as `setoption name NNUE file value <path>`.
    AsyncFunction("start") { () throws -> String in
      guard let network = Bundle.main.paths(forResourcesOfType: "nnue", inDirectory: nil).first else {
        throw NoNetworkException()
      }
      let dir = (network as NSString).deletingLastPathComponent
      ArasanBridge.start(withProgramPath: dir + "/arasan") { [weak self] line in
        self?.sendEvent("onLine", ["line": line])
      }
      return network
    }

    Function("send") { (command: String) in
      ArasanBridge.send(command)
    }

    // The engine stays loaded for the life of the app; just stop any search.
    Function("stop") {
      ArasanBridge.send("stop")
    }
  }
}

final class NoNetworkException: Exception {
  override var reason: String {
    "Arasan network not packaged"
  }
}
