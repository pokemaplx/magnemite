#!/system/bin/sh
# Started by init from magnemite.rc, as root, once sys.boot_completed is 1.
#
# This is the Redroid half of what the Magisk module splits in two: the
# first-boot provisioning of customize.sh, and the environment service.sh sets
# up before exec'ing the agent. init owns the respawn loop, so there is none
# here.

DATADIR=/data/adb/magnemite
BIN="$DATADIR/magnemite-agent"
SEED=/system/bin/magnemite-agent
LOG="$DATADIR/agent.log"
MAX_LOG_BYTES=2097152

mkdir -p "$DATADIR"
chmod 700 "$DATADIR"

# The box is booted, but the network usually is not quite yet.
sleep 10

# Keep the log from filling the /data volume. init restarts this script on every
# exit, so this runs as often as service.sh's loop did.
if [ -f "$LOG" ]; then
	size=$(stat -c %s "$LOG" 2>/dev/null || echo 0)
	if [ "$size" -gt "$MAX_LOG_BYTES" ]; then
		mv "$LOG" "$LOG.1"
	fi
fi

# --- The binary runs from /data, not from /system.
#
# /system is read-only at runtime, and the agent's self-update writes the new
# binary next to os.Executable(). Running straight out of /system/bin would
# leave the fleet with no way to update itself over the air, so the image ships
# a seed copy and the agent runs from a writable directory.
#
# The version marker is what keeps the two from fighting: rebuilding the image
# replaces the binary, an OTA update between rebuilds survives a restart.
SEEDV=$("$SEED" -version 2>/dev/null)
if [ ! -x "$BIN" ] || [ "$SEEDV" != "$(cat "$DATADIR/.seed-version" 2>/dev/null)" ]; then
	echo "[magnemite] seeding agent $SEEDV from the image"
	cp "$SEED" "$BIN" && chmod 755 "$BIN" && echo "$SEEDV" >"$DATADIR/.seed-version"
fi

# Last resort, for when the seeding above could not run either -- a full /data
# is the realistic way that happens. Falls back to the binary the last
# self-update replaced rather than looping on a missing one forever.
if [ ! -x "$BIN" ] && [ -x "$BIN.old" ]; then
	echo "[magnemite] restoring previous agent binary"
	mv "$BIN.old" "$BIN"
fi

# --- Enrollment comes from properties, which Redroid takes on the docker
# command line. Nothing is baked into the image, so one image serves every
# fleet and holds no secret.
SERVER=$(getprop ro.magnemite.server)
TOKEN=$(getprop ro.magnemite.enroll_token)
SERIAL=$(getprop ro.magnemite.serial)
REBOOT=$(getprop ro.magnemite.reboot_cmd)

set -- -config "$DATADIR/config.json"
[ -n "$SERVER" ] && set -- "$@" -server "$SERVER"
[ -n "$TOKEN" ] && set -- "$@" -enroll-token "$TOKEN"
[ -n "$SERIAL" ] && set -- "$@" -serial "$SERIAL"
[ -n "$REBOOT" ] && set -- "$@" -reboot-command "$REBOOT"

# Android keeps its CA certificates where Go does not look, so a TLS handshake
# fails with "certificate signed by unknown authority". The agent handles this
# itself; exporting it also fixes an older binary still on the box.
export SSL_CERT_DIR=/apex/com.android.conscrypt/cacerts:/system/etc/security/cacerts

# exec, so the agent keeps this PID and init supervises it directly, which is
# what the agent's own syscall.Exec self-update relies on.
#
# The redirect is not optional: the agent logs to stderr, and init sends a
# service's output to /dev/null. Without it $LOG never exists, and a log bundle
# collected from the dashboard would arrive with the agent's own half missing.
echo "[magnemite] starting agent at $(date)" >>"$LOG"
exec "$BIN" "$@" >>"$LOG" 2>&1
