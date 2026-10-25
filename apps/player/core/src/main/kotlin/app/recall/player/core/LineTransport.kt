// P2.3.3: one connection to the broker. An interface so the line's logic (ScreenLine) is tested with
// a fake; PahoTransport is the real one (MQTT 3.1.1 over TLS, Eclipse Paho).
package app.recall.player.core

import javax.net.ssl.SSLSocketFactory
import org.eclipse.paho.client.mqttv3.IMqttDeliveryToken
import org.eclipse.paho.client.mqttv3.MqttCallback
import org.eclipse.paho.client.mqttv3.MqttClient
import org.eclipse.paho.client.mqttv3.MqttConnectOptions
import org.eclipse.paho.client.mqttv3.MqttMessage
import org.eclipse.paho.client.mqttv3.persist.MemoryPersistence

interface LineTransport {
    /** Opens the connection (blocking; throws when refused). Messages and the end go to the callbacks. */
    fun connect(onMessage: (topic: String, payload: ByteArray) -> Unit, onLost: (Throwable?) -> Unit)

    /** Subscribes (blocking); throws when the broker refuses. */
    fun subscribe(filter: String)

    /** Sends at least once (blocking until the broker has it); throws when the line is gone. */
    fun publish(topic: String, payload: ByteArray)

    fun close()
}

class PahoTransport(
    private val url: String,
    private val clientId: String,
    private val socketFactory: SSLSocketFactory,
    private val keepAliveSeconds: Int = 60,
) : LineTransport {
    private val client = MqttClient(url, clientId, MemoryPersistence()).apply {
        timeToWait = 30_000 // no call waits longer than this for the broker
    }

    override fun connect(onMessage: (String, ByteArray) -> Unit, onLost: (Throwable?) -> Unit) {
        client.setCallback(object : MqttCallback {
            override fun connectionLost(cause: Throwable?) = onLost(cause)
            override fun messageArrived(topic: String, message: MqttMessage) = onMessage(topic, message.payload)
            override fun deliveryComplete(token: IMqttDeliveryToken?) {}
        })
        client.connect(MqttConnectOptions().apply {
            isCleanSession = true
            isAutomaticReconnect = false // ScreenLine decides when to try again
            mqttVersion = MqttConnectOptions.MQTT_VERSION_3_1_1
            keepAliveInterval = keepAliveSeconds
            connectionTimeout = 20
            socketFactory = this@PahoTransport.socketFactory
            isHttpsHostnameVerificationEnabled = true
        })
    }

    override fun subscribe(filter: String) {
        val token = client.subscribeWithResponse(filter, 1)
        token.waitForCompletion(20_000)
        val granted = token.grantedQos.firstOrNull() ?: 0x80
        check(granted in 0..2) { "subscription to $filter refused" }
    }

    override fun publish(topic: String, payload: ByteArray) {
        client.publish(topic, payload, 1, false)
    }

    override fun close() {
        runCatching { if (client.isConnected) client.disconnectForcibly(1_000, 1_000) }
        runCatching { client.close(true) }
    }
}
