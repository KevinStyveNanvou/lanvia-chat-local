package ai.arena.lanvia

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

class LanviaTransferService : Service() {
    companion object {
        const val ACTION_START = "ai.arena.lanvia.START_FOREGROUND"
        const val ACTION_STOP = "ai.arena.lanvia.STOP_FOREGROUND"
        private const val CHANNEL_ID = "lanvia_transfer_service"
        private const val NOTIFICATION_ID = 53212
    }

    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, "LANVIA availability and transfers", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Keeps direct local transfers active"
                setShowBadge(false)
            })
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) { stopForeground(STOP_FOREGROUND_REMOVE); stopSelf(); return START_NOT_STICKY }
        val title = intent?.getStringExtra("title") ?: "LANVIA"
        val text = intent?.getStringExtra("text") ?: "Available on your local network"
        val progress = intent?.getIntExtra("progress", -1) ?: -1
        val launch = packageManager.getLaunchIntentForPackage(packageName) ?: Intent(this, MainActivity::class.java)
        val pending = PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_lanvia)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(pending)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .apply { if (progress >= 0) setProgress(100, progress.coerceIn(0, 100), false) }
            .build()
        startForeground(NOTIFICATION_ID, notification)
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
