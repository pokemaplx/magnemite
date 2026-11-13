#!/system/bin/sh
# Give one package Magisk's permission to use root, and keep giving it.
#
#   magnemite-root-grant <package>
#
# Called by the agent after every install, because installing is what breaks
# root. Three facts compound:
#
#   - Magisk keys its su policy on the **uid**, not the package name.
#   - Android hands a package a new uid when it is installed fresh rather than
#     updated, so a reinstall silently invalidates whatever was granted.
#   - A request nobody answers times out as a *deny*, and that deny is written
#     down. On hardware somebody taps Grant; a container has no screen, so the
#     first thing a new box learns about its scanner is to refuse it.
#
# What that costs is invisible from outside, which is why this exists at all:
# the scanner comes back from a rollout running, reporting healthy, and doing
# nothing. Its injector shells out, the shell cannot even traverse /data/adb
# (0700, root), and the error lands in the middle of a command line as a
# parameter — "Cannot parse integer value for -p". Nothing says "no root".
#
# Safe to run on a package that already has it: REPLACE rewrites the row.

set -eu

pkg=${1:-}
if [ -z "$pkg" ]; then
	echo "usage: magnemite-root-grant <package>" >&2
	exit 2
fi

# Both ways this can find nothing to do are faults, not no-ops: it runs on a
# Redroid box moments after Magnemite installed that very package. Exiting 0
# would have the agent log them at INFO on a green job, which is how a scanner
# ends up with no root and nothing saying so.
# Where magisk actually is, rather than wherever $PATH happens to look.
#
# This used to be `command -v magisk`, and that is a coin toss: init gives a
# service Android's default PATH -- /system/bin and friends -- and /sbin has
# not been on it since Android 10. So the lookup can come up empty on a box
# whose root works perfectly, and the only thing anyone sees is this script's
# own "no magisk" on a green job.
#
# /sbin first, because that is where this image's bootanim.rc hook puts the
# copy that matches the running daemon; /debug_ramdisk because that is where
# Magisk mounts itself on Android 11 and up, for an image that stops passing
# the path. The seed in /system is last and is always there -- any copy of the
# binary can reach the daemon, since --sqlite talks to it over a socket.
MAGISK=""
for candidate in /sbin/magisk /debug_ramdisk/magisk /system/etc/init/magisk/magisk; do
	if [ -x "$candidate" ]; then
		MAGISK=$candidate
		break
	fi
done
# And still ask $PATH, for a box that keeps it somewhere none of those cover.
[ -n "$MAGISK" ] || MAGISK=$(command -v magisk 2>/dev/null || true)
if [ -z "$MAGISK" ]; then
	echo "no magisk on this box, so nothing can grant root" >&2
	exit 1
fi

# `pm list packages -U` prints one "package:<name> uid:<n>" per line.
#
# grep and shell expansion rather than awk, deliberately: Android ships toybox,
# and awk is not part of it on every build. A missing awk here would not fail
# loudly -- it would leave the uid empty, take the "not installed" path, and
# report that it had nothing to do.
#
# -F because a package name is full of dots, which are regex wildcards, and the
# trailing " uid:" is what keeps com.foo from matching com.foobar.
line=$(pm list packages -U 2>/dev/null | grep -F -m1 "package:$pkg uid:" || true)
uid=${line##*uid:}

if [ -z "$uid" ]; then
	echo "$pkg is not installed, so there is no uid to grant root to" >&2
	exit 1
fi

# policy 2 is ALLOW (0 asks, 1 denies). until=0 is forever, and both the log
# and the notification are off: there is nobody here to read either, and a
# toast per su call on a box running a scanner is noise with a cost.
"$MAGISK" --sqlite \
	"REPLACE INTO policies (uid,policy,until,logging,notification) VALUES($uid,2,0,0,0)"

# And drop the rows that belong to nobody.
#
# Every reinstall leaves one behind: the package's previous uid, still holding
# an ALLOW. Android reuses uids as apps come and go, so left alone these
# accumulate into standing grants for whatever lands on those numbers next --
# given by a file nobody reads, to an app nobody chose.
#
# Built from the live package list, so a uid that still belongs to something is
# never touched, whatever its policy says. Never fatal: the grant above is the
# job, and this is hygiene.
live=$(pm list packages -U 2>/dev/null | sed -n 's/.*uid:\([0-9][0-9]*\).*/\1/p' | tr '\n' ',')
if [ -n "$live" ]; then
	"$MAGISK" --sqlite "DELETE FROM policies WHERE uid NOT IN (${live%,})" || true
fi

# And read it back, because `magisk --sqlite` exits 0 whatever the SQL did.
#
# The daemon discards the statement's result and the client returns 0 at the
# end-of-output marker, so a REPLACE that failed -- a full /data, or a Magisk
# that rebuilt the `policies` table again, which it has done before -- is
# indistinguishable from one that worked. `set -e` never fires, and the line
# below would announce a grant that is not there.
#
# That is the exact failure this script exists to remove, and `logging=0` above
# means there is no su log to check it against either. `case` rather than
# `grep -q`, so no match cannot abort under `set -e`, and empty output -- a
# read that failed too -- falls through and fails closed.
case $("$MAGISK" --sqlite "SELECT policy FROM policies WHERE uid=$uid" 2>&1) in
*policy=2*) ;;
*)
	echo "could not grant root to $pkg (uid $uid): the policy row did not take" >&2
	exit 1
	;;
esac

echo "granted root to $pkg (uid $uid)"
