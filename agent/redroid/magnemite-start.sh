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

# --- Magisk's busybox, seeded the same way and for the same reason.
#
# The scanner's injector calls /data/adb/magisk/busybox by absolute path, and
# this image's Magisk gives root without ever putting one there -- that
# directory is empty on a fresh box. What the operator sees when it is missing
# is not an error about busybox: the shell's failure is substituted into the
# injector's command line, and the scanner reports "Cannot parse integer value
# for -p" while looking otherwise healthy.
#
# Checked by applet rather than by existence, because the two near misses both
# exist and neither works: a symlink to Android's toybox answers "Unknown
# command busybox" (toybox picks its applet from argv[0]), and Debian's
# busybox-static is built without pgrep, which is the one the injector needs.
#
# Two tests, and the second is what makes an upgrade land. "Has pgrep" alone
# is satisfied by the busybox already there, so bumping MAGISK in the image
# would never reach a box whose /data survived -- which is every box, since
# that volume outliving the container is the whole point of seeding. The agent
# binary above has the same problem and solves it with a version marker; this
# compares the two binaries' own banners, which needs no marker at all.
BUSYBOX_SEED=/system/bin/magnemite-busybox
BUSYBOX=/data/adb/magisk/busybox
BUSYBOX_SEEDV=$("$BUSYBOX_SEED" 2>/dev/null | head -1)
BUSYBOX_HAVEV=$("$BUSYBOX" 2>/dev/null | head -1)
if [ -x "$BUSYBOX_SEED" ] &&
	{ [ "$BUSYBOX_SEEDV" != "$BUSYBOX_HAVEV" ] ||
		! "$BUSYBOX" --list 2>/dev/null | grep -qx pgrep; }; then
	# To the log and not to stdout: init sends a service's output to
	# /dev/null, so an echo here is written nowhere -- and a seed that failed
	# would look exactly like one that was never needed.
	echo "[magnemite] seeding Magisk busybox" >>"$LOG"
	mkdir -p /data/adb/magisk
	# Removed first: what is there may be a symlink, and cp would follow it
	# into /system, which is read-only -- so the copy would fail rather than
	# replace the thing that is broken.
	rm -f "$BUSYBOX"
	cp "$BUSYBOX_SEED" "$BUSYBOX" && chmod 0755 "$BUSYBOX" ||
		echo "[magnemite] could not seed $BUSYBOX" >>"$LOG"
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
