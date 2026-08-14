package ai.arena.lanvia

import android.content.Context
import android.content.Intent
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.net.Inet4Address
import java.net.NetworkInterface
import java.nio.charset.StandardCharsets
import java.util.Collections

class MainActivity : FlutterActivity(), EventChannel.StreamHandler {
    companion object {
        private const val METHOD_CHANNEL = "ai.arena.lanvia/network"
        private const val EVENT_CHANNEL = "ai.arena.lanvia/mdns_events"
        private const val TAG = "LANVIA"
    }

    private lateinit var nsdManager: NsdManager
    private var eventSink: EventChannel.EventSink? = null
    private var registrationListener: NsdManager.RegistrationListener? = null
    private var discoveryListener: NsdManager.DiscoveryListener? = null
    private var multicastLock: WifiManager.MulticastLock? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        nsdManager = getSystemService(Context.NSD_SERVICE) as NsdManager
        EventChannel(flutterEngine.dartExecutor.binaryMessenger, EVENT_CHANNEL).setStreamHandler(this)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, METHOD_CHANNEL).setMethodCallHandler(::handleMethod)
    }

    override fun onListen(arguments: Any?, events: EventChannel.EventSink?) { eventSink = events }
    override fun onCancel(arguments: Any?) { eventSink = null }

    private fun handleMethod(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "startMdns" -> {
                try {
                    @Suppress("UNCHECKED_CAST")
                    startMdns(call.arguments as Map<String, Any?>)
                    result.success(null)
                } catch (error: Exception) { result.error("mdns_start", error.message, null) }
            }
            "stopMdns" -> { stopMdns(); result.success(null) }
            "getNetworkInterfaces" -> result.success(networkInterfaces())
            "startForeground" -> {
                val intent = Intent(this, LanviaTransferService::class.java).apply {
                    action = LanviaTransferService.ACTION_START
                    putExtra("title", call.argument<String>("title") ?: "LANVIA")
                    putExtra("text", call.argument<String>("text") ?: "Available on your local network")
                    putExtra("progress", call.argument<Int>("progress") ?: -1)
                }
                ContextCompat.startForegroundService(this, intent)
                result.success(null)
            }
            "stopForeground" -> {
                startService(Intent(this, LanviaTransferService::class.java).apply { action = LanviaTransferService.ACTION_STOP })
                result.success(null)
            }
            else -> result.notImplemented()
        }
    }

    private fun startMdns(args: Map<String, Any?>) {
        stopMdns()
        val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        multicastLock = wifi.createMulticastLock("lanvia-mdns").apply { setReferenceCounted(false); acquire() }
        val id = args["deviceId"] as String
        val info = NsdServiceInfo().apply {
            serviceName = "LANVIA-${id.take(8)}"
            serviceType = "_lanvia._tcp."
            port = args["controlPort"] as Int
            setAttribute("id", id)
            setAttribute("name", args["deviceName"] as String)
            setAttribute("type", "mobile")
            setAttribute("platform", "android")
            setAttribute("version", args["appVersion"] as String)
            setAttribute("protocol", args["protocolVersion"] as String)
            setAttribute("control", (args["controlPort"] as Int).toString())
            setAttribute("transfer", (args["transferPort"] as Int).toString())
        }
        registrationListener = object : NsdManager.RegistrationListener {
            override fun onServiceRegistered(serviceInfo: NsdServiceInfo) { emit(mapOf("kind" to "status", "status" to "running")) }
            override fun onRegistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) { emitError("mDNS registration failed: $errorCode") }
            override fun onServiceUnregistered(serviceInfo: NsdServiceInfo) = Unit
            override fun onUnregistrationFailed(serviceInfo: NsdServiceInfo, errorCode: Int) { emitError("mDNS unregister failed: $errorCode") }
        }.also { nsdManager.registerService(info, NsdManager.PROTOCOL_DNS_SD, it) }

        discoveryListener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) = Unit
            override fun onServiceFound(serviceInfo: NsdServiceInfo) {
                if (serviceInfo.serviceName == info.serviceName) return
                resolve(serviceInfo)
            }
            override fun onServiceLost(serviceInfo: NsdServiceInfo) = Unit
            override fun onDiscoveryStopped(serviceType: String) = Unit
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) { emitError("mDNS discovery failed: $errorCode") }
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) { emitError("mDNS stop failed: $errorCode") }
        }.also { nsdManager.discoverServices("_lanvia._tcp.", NsdManager.PROTOCOL_DNS_SD, it) }
    }

    @Suppress("DEPRECATION")
    private fun resolve(service: NsdServiceInfo) {
        nsdManager.resolveService(service, object : NsdManager.ResolveListener {
            override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                Log.d(TAG, "Resolve failed $errorCode for ${serviceInfo.serviceName}")
            }
            override fun onServiceResolved(info: NsdServiceInfo) {
                val attributes = info.attributes.mapValues { String(it.value, StandardCharsets.UTF_8) }
                val address = info.host?.hostAddress ?: return
                emit(mapOf(
                    "kind" to "device", "address" to address, "port" to info.port,
                    "id" to attributes["id"], "name" to attributes["name"],
                    "type" to attributes["type"], "platform" to attributes["platform"],
                    "version" to attributes["version"], "protocol" to attributes["protocol"],
                    "control" to attributes["control"], "transfer" to attributes["transfer"]
                ))
            }
        })
    }

    private fun stopMdns() {
        discoveryListener?.let { try { nsdManager.stopServiceDiscovery(it) } catch (_: Exception) {} }
        registrationListener?.let { try { nsdManager.unregisterService(it) } catch (_: Exception) {} }
        discoveryListener = null
        registrationListener = null
        multicastLock?.let { if (it.isHeld) it.release() }
        multicastLock = null
    }

    private fun networkInterfaces(): List<Map<String, Any>> {
        val result = mutableListOf<Map<String, Any>>()
        val interfaces = Collections.list(NetworkInterface.getNetworkInterfaces())
        for (network in interfaces) {
            if (!network.isUp || network.isLoopback) continue
            for (entry in network.interfaceAddresses) {
                val address = entry.address
                if (address !is Inet4Address || address.isLoopbackAddress || address.isLinkLocalAddress) continue
                result += mapOf(
                    "name" to network.displayName,
                    "address" to address.hostAddress.orEmpty(),
                    "broadcast" to (entry.broadcast?.hostAddress ?: "255.255.255.255"),
                    "prefixLength" to entry.networkPrefixLength.toInt()
                )
            }
        }
        return result
    }

    private fun emit(value: Map<String, Any?>) { runOnUiThread { eventSink?.success(value) } }
    private fun emitError(message: String) { emit(mapOf("kind" to "status", "status" to "error", "error" to message)) }

    override fun onDestroy() { stopMdns(); super.onDestroy() }
}
