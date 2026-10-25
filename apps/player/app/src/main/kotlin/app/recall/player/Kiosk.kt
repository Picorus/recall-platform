// P2.2: kiosk mode. As device owner the player locks the box to itself: it is the home screen, the
// only app that can run, with no status bar, no lock screen, and no way to reset or boot the box into
// safe mode from the box itself.
package app.recall.player

import android.app.Activity
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.UserManager

object Kiosk {
    fun admin(context: Context) = ComponentName(context, RecallAdminReceiver::class.java)

    private fun dpm(context: Context) =
        context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager

    fun isDeviceOwner(context: Context): Boolean = dpm(context).isDeviceOwnerApp(context.packageName)

    /** Box rules, set every start (cheap, and repairs anything changed). Only a device owner can. */
    fun applyPolicies(context: Context) {
        if (!isDeviceOwner(context)) return
        val dpm = dpm(context)
        val admin = admin(context)
        dpm.setLockTaskPackages(admin, arrayOf(context.packageName))
        // Nothing of the system shows while locked: no home button, no notifications, no status bar.
        dpm.setLockTaskFeatures(admin, DevicePolicyManager.LOCK_TASK_FEATURE_NONE)
        dpm.setKeyguardDisabled(admin, true)
        dpm.setStatusBarDisabled(admin, true)
        val restrictions = mutableListOf(
            UserManager.DISALLOW_FACTORY_RESET,
            UserManager.DISALLOW_SAFE_BOOT,
            UserManager.DISALLOW_ADD_USER,
            UserManager.DISALLOW_MOUNT_PHYSICAL_MEDIA,
            UserManager.DISALLOW_USB_FILE_TRANSFER,
            UserManager.DISALLOW_CONFIG_DATE_TIME,
        )
        // Release builds also close the debugging port; test builds keep it for the emulator checks.
        if (!BuildConfig.DEBUG) restrictions += UserManager.DISALLOW_DEBUGGING_FEATURES
        restrictions.forEach { dpm.addUserRestriction(admin, it) }
        // P2.8: the box reads GPS for areas and proof; nobody is there to tap "allow".
        runCatching {
            for (p in listOf(android.Manifest.permission.ACCESS_FINE_LOCATION, android.Manifest.permission.ACCESS_COARSE_LOCATION)) {
                dpm.setPermissionGrantState(admin, context.packageName, p, DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED)
            }
            dpm.setLocationEnabled(admin, true)
        }.onFailure { CrashLog.record(context, "location not granted: ${it.javaClass.simpleName}") }
        // Always our home screen, whatever else is installed.
        val home = IntentFilter(Intent.ACTION_MAIN).apply {
            addCategory(Intent.CATEGORY_HOME)
            addCategory(Intent.CATEGORY_DEFAULT)
        }
        dpm.addPersistentPreferredActivity(admin, home, ComponentName(context, MainActivity::class.java))
    }

    /** Locks the screen to the player (does nothing when not device owner, e.g. a developer phone). */
    fun lock(activity: Activity) {
        if (isDeviceOwner(activity) && dpm(activity).isLockTaskPermitted(activity.packageName)) {
            val am = activity.getSystemService(Context.ACTIVITY_SERVICE) as android.app.ActivityManager
            if (am.lockTaskModeState == android.app.ActivityManager.LOCK_TASK_MODE_NONE) activity.startLockTask()
        }
    }
}
