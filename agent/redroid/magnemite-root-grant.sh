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
command -v magisk >/dev/null 2>&1 || {
	echo "no magisk on this box, so nothing can grant root" >&2
	exit 1
}

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
magisk --sqlite \
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
	magisk --sqlite "DELETE FROM policies WHERE uid NOT IN (${live%,})" || true
fi

echo "granted root to $pkg (uid $uid)"
