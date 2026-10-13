# syntax=docker/dockerfile:1
#
# The Redroid counterpart of the Magisk module zip: this image *is* the install.
# Build it with `make redroid`; each box is then one container of it, configured
# by the properties Redroid takes on the docker command line. Nothing here holds
# a token, so one image serves every fleet.
#
# Versioned by the `redroid=` line of VERSION, not the agent's: the binary below
# is a seed the box's own self-update replaces, so tying the tag to the agent
# would recreate every container on a machine for each agent release.
#
# Build context is agent/, so agent/bin/ and agent/redroid/ are both in scope.

# The official Redroid image, and **64-bit only** on purpose.
#
# An arm64 Android normally ships two zygotes, and the 32-bit one needs AArch32
# -- which Arm has been removing generation by generation. Neoverse N1 and V1
# (Ampere Altra, Graviton 2 and 3) still have it at EL0; V2 and V3 (Graviton 4
# and 5, Google Axion, NVIDIA Grace) and every Apple Silicon do not. There the
# 32-bit zygote cannot start, and the symptom is a container that runs with an
# Android that never finishes booting -- an instance left `running, not
# enrolled`, which reads like a network fault and is not one.
#
# A 64-only image removes the half that cannot run, and nothing is lost: the
# fleet's .apkm bundles carry an arm64-v8a split and the agent picks a split by
# exact ABI match, so no 32-bit runtime was ever used by anything here.
#
# The 64only variants start at Android 12, which is why this is 12 and not 11.
ARG REDROID=redroid/redroid:12.0.0_64only-latest

# Magisk, injected here rather than inherited from a prerooted base.
#
# This used to be `abing7k/redroid:a11_magisk_arm`, and that was a dead end:
# the image carries Magisk Delta 25206 canary from a 2023 androidfilehost
# mirror, Delta's own repositories are gone from GitHub, and the repo that
# built it says it is no longer maintained. Nobody can rebuild that image,
# including its author.
#
# So the injection is ours now, and it is the same one `ayasa520/redroid-script`
# performs -- the script abing7k forked, still maintained, and the source of
# every line of the init block below. Bootless Magisk is a handful of binaries
# under /system/etc/init/magisk plus a hook in bootanim.rc, so doing it here
# keeps the whole thing to one `docker build` on the machine: no python, no
# lzip, and no third-party script fetched while provisioning.
#
# One consequence worth knowing rather than discovering. This is **upstream**
# Magisk, not Delta, so hiding is Zygisk and the DenyList -- `zygisk=1` and a
# list of packages -- and not Delta's MagiskHide (`hide=1`), which no longer
# exists anywhere to install.
#
# Pinned rather than latest, because it runs as root on every box.
ARG MAGISK=v30.7

# Only so a later stage can read files out of the base. Android is not a Linux
# distribution and has no /bin/sh, so nothing can be computed *in* the image --
# every byte has to arrive by COPY.
FROM ${REDROID} AS base

FROM alpine:3.20 AS magisk
ARG MAGISK

# The real one, rather than a copy written down here. It is byte-identical to
# the version the script hardcodes today, and reading it means a change
# upstream is inherited instead of silently overwritten.
COPY --from=base /system/etc/init/bootanim.rc /tmp/bootanim.rc

RUN apk add --no-cache curl unzip

RUN <<'SH'
set -eu

curl -fsSL -o /tmp/magisk.apk \
    "https://github.com/topjohnwu/Magisk/releases/download/${MAGISK}/Magisk-${MAGISK}.apk"
unzip -o /tmp/magisk.apk 'lib/arm64-v8a/*' -d /tmp/magisk

OUT=/out
mkdir -p "$OUT/system/etc/init/magisk" "$OUT/sbin"

# libmagisk.so becomes magisk, libmagiskpolicy.so becomes magiskpolicy, and so
# on -- the names the init block below calls. v30.7 ships one unified
# libmagisk.so, which is why that block runs `magisk` and not `magisk64`; a
# version that splits them again needs the block changed with it, so the three
# asserts below are what turns that into a failed build rather than a box that
# boots without root.
for so in /tmp/magisk/lib/arm64-v8a/lib*.so; do
    name=$(basename "$so" .so)
    install -m 0755 "$so" "$OUT/system/etc/init/magisk/${name#lib}"
done
test -x "$OUT/system/etc/init/magisk/magisk"
test -x "$OUT/system/etc/init/magisk/magiskpolicy"
test -x "$OUT/system/etc/init/magisk/busybox"

# The app installs itself on first boot, from here.
install -m 0644 /tmp/magisk.apk "$OUT/system/etc/init/magisk/magisk.apk"

# Updating Magisk from the app rewrites bootanim.rc, and this is the copy it
# restores from. Not decoration: without it an in-app update can leave a box
# with no way back to an init that boots.
gzip -c /tmp/bootanim.rc >"$OUT/system/etc/init/bootanim.rc.gz"
chmod 0644 "$OUT/system/etc/init/bootanim.rc.gz"

# The hook itself, appended to the real file. Every `exec` here is Magisk's own
# startup sequence; the package checked on the last one is upstream's, where
# the script still names Delta's and therefore reinstalls on every boot.
cp /tmp/bootanim.rc "$OUT/system/etc/init/bootanim.rc"
cat >>"$OUT/system/etc/init/bootanim.rc" <<'RC'

on post-fs-data
    start logd
    exec u:r:su:s0 root root -- /system/etc/init/magisk/magiskpolicy --live --magisk
    exec u:r:magisk:s0 root root -- /system/etc/init/magisk/magiskpolicy --live --magisk
    exec u:r:update_engine:s0 root root -- /system/etc/init/magisk/magiskpolicy --live --magisk
    exec u:r:su:s0 root root -- /system/etc/init/magisk/magisk --auto-selinux --setup-sbin /system/etc/init/magisk /sbin
    exec u:r:su:s0 root root -- /sbin/magisk --auto-selinux --post-fs-data

on nonencrypted
    exec u:r:su:s0 root root -- /sbin/magisk --auto-selinux --service

on property:vold.decrypt=trigger_restart_framework
    exec u:r:su:s0 root root -- /sbin/magisk --auto-selinux --service

on property:sys.boot_completed=1
    mkdir /data/adb/magisk 755
    exec u:r:su:s0 root root -- /sbin/magisk --auto-selinux --boot-complete
    exec -- /system/bin/sh -c "if [ ! -e /data/data/com.topjohnwu.magisk ] ; then pm install /system/etc/init/magisk/magisk.apk ; fi"

on property:init.svc.zygote=restarting
    exec u:r:su:s0 root root -- /sbin/magisk --auto-selinux --zygote-restart

on property:init.svc.zygote=stopped
    exec u:r:su:s0 root root -- /sbin/magisk --auto-selinux --zygote-restart
RC
chmod 0644 "$OUT/system/etc/init/bootanim.rc"
SH

FROM ${REDROID}

# Magisk's tree, modes carried over from the stage that built it.
COPY --from=magisk /out/ /

# arm64 only, deliberately: the fleet's .apkm bundles carry an arm64-v8a split
# and the agent picks a split by exact ABI match. An x86_64 Redroid would need
# ARM translation and a different split policy.
#
# --chmod rather than RUN chmod: the base image is an Android system, not a
# Linux distribution, and has no /bin/sh for a RUN layer to use.
COPY --chmod=0755 bin/magnemite-agent-linux-arm64 /system/bin/magnemite-agent
COPY --chmod=0755 redroid/magnemite-start.sh /system/bin/magnemite-start.sh

# Seeded into /data at boot by the start script, for the same reason the agent
# binary is: /data is a volume, so nothing this image puts there survives.
#
# The scanner's injector calls /data/adb/magisk/busybox by absolute path and
# needs an applet Android's toybox does not have, so the seed is Magisk's own
# busybox -- taken from the tree above rather than downloaded a second time.
COPY --from=magisk --chmod=0755 \
    /out/system/etc/init/magisk/busybox /system/bin/magnemite-busybox

# Run by the agent after every install. Installing is what breaks root: Magisk
# keys its policy on the uid, a fresh install changes it, and a prompt nobody
# can answer is written down as a deny.
COPY --chmod=0755 redroid/magnemite-root-grant.sh /system/bin/magnemite-root-grant

# init reads every .rc under this directory at boot.
COPY --chmod=0644 redroid/magnemite.rc /system/etc/init/magnemite.rc
