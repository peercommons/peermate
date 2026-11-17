package expo.modules.arasanengine

import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.BufferedWriter
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStreamWriter

// Runs the Arasan chess engine as a child process and speaks UCI over its
// stdin/stdout (SPECS.md §5).
//
// The engine is packaged as jniLibs/<abi>/libarasan.so so Android extracts it to
// nativeLibraryDir, the one place an app may execute files from on Android 10+.
// The network ships as an asset and is copied to filesDir once, because the
// engine needs a real file path.
class ArasanEngineModule : Module() {
  private var process: Process? = null
  private var writer: BufferedWriter? = null

  override fun definition() = ModuleDefinition {
    Name("ArasanEngine")

    Events("onLine")

    // Starts the engine (if needed). Resolves with the network's file path, which
    // the caller passes as `setoption name NNUE file value <path>`.
    AsyncFunction("start") {
      val context = appContext.reactContext ?: throw CodedException("ERR_NO_CONTEXT", "No Android context", null)
      val network = ensureNetwork(context.filesDir, context.assets)
      if (process?.isAlive == true) return@AsyncFunction network.absolutePath

      val exe = File(context.applicationInfo.nativeLibraryDir, "libarasan.so")
      if (!exe.exists()) {
        throw CodedException("ERR_NO_ENGINE", "Arasan isn't packaged for this CPU architecture", null)
      }

      val proc = ProcessBuilder(exe.absolutePath)
        .directory(network.parentFile)
        .redirectErrorStream(true)
        .start()
      process = proc
      writer = BufferedWriter(OutputStreamWriter(proc.outputStream))

      Thread({
        try {
          proc.inputStream.bufferedReader().forEachLine { line ->
            sendEvent("onLine", mapOf("line" to line))
          }
        } catch (_: Exception) {
          // Stream closed because the engine was stopped.
        }
      }, "arasan-stdout").apply { isDaemon = true }.start()

      network.absolutePath
    }

    Function("send") { command: String ->
      val w = writer ?: throw CodedException("ERR_NOT_STARTED", "Engine not started", null)
      w.write(command)
      w.newLine()
      w.flush()
    }

    Function("stop") {
      stopEngine()
    }

    OnDestroy {
      stopEngine()
    }
  }

  private fun stopEngine() {
    try {
      writer?.apply {
        write("quit")
        newLine()
        flush()
      }
    } catch (_: Exception) {
    }
    process?.destroy()
    process = null
    writer = null
  }

  private fun ensureNetwork(filesDir: File, assets: android.content.res.AssetManager): File {
    val dir = File(filesDir, "arasan").apply { mkdirs() }
    val name = assets.list("")?.firstOrNull { it.endsWith(".nnue") }
      ?: throw CodedException("ERR_NO_NETWORK", "Arasan network not packaged", null)
    val target = File(dir, name)
    if (target.exists() && target.length() > 0) return target

    // Copy to a temp file first so an interrupted copy is never mistaken for a good one.
    val tmp = File(dir, "$name.tmp")
    assets.open(name).use { input -> FileOutputStream(tmp).use { input.copyTo(it) } }
    if (!tmp.renameTo(target)) throw CodedException("ERR_NETWORK_COPY", "Couldn't install the network", null)
    // Remove networks from older app versions.
    dir.listFiles()?.filter { it.name.endsWith(".nnue") && it.name != name }?.forEach { it.delete() }
    return target
  }
}
