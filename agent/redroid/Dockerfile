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

# Magisk-prerooted, because Cosmog needs Magisk -- hidden from its worker
# processes -- and upstream Redroid ships none.
ARG REDROID=abing7k/redroid:a11_magisk_arm
FROM ${REDROID}

# arm64 only, deliberately: the fleet's .apkm bundles carry an arm64-v8a split
# and the agent picks a split by exact ABI match. An x86_64 Redroid would need
# ARM translation and a different split policy.
#
# `_arm` in that tag is the *host* architecture, not a 32-bit guest -- the
# image is linux/arm64, which is why the arm64 binary below is still the right
# one. The `_amd` tags are the x86_64 variants, and `a11_magisk_ndk_arm` does
# not exist because `ndk` is the ARM native bridge an ARM host has no use for.
#
# --chmod rather than RUN chmod: the base image is an Android system, not a
# Linux distribution, and has no /bin/sh for a RUN layer to use.
COPY --chmod=0755 bin/magnemite-agent-linux-arm64 /system/bin/magnemite-agent
COPY --chmod=0755 redroid/magnemite-start.sh /system/bin/magnemite-start.sh

# init reads every .rc under this directory at boot.
COPY --chmod=0644 redroid/magnemite.rc /system/etc/init/magnemite.rc
