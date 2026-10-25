package app.recall.player

import android.app.admin.DeviceAdminReceiver

/** Makes the player the box's device owner (set once at the warehouse: docs/RUNBOOKS/screen-setup.md). */
class RecallAdminReceiver : DeviceAdminReceiver()
