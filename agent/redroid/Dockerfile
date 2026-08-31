# syntax=docker/dockerfile:1
#
# The Redroid counterpart of the Magisk module zip: this image *is* the install.
# Build it once per agent version with `make redroid`; each box is then one
# container of it, configured by the properties Redroid takes on the docker
# command line. Nothing here holds a token, so one image serves every fleet.
#
# Build context is agent/, so agent/bin/ and agent/redroid/ are both in scope.

ARG REDROID=redroid/redroid:13.0.0_64only-latest
FROM ${REDROID}

# arm64 only, deliberately: the fleet's .apkm bundles carry an arm64-v8a split
# and the agent picks a split by exact ABI match. An x86_64 Redroid would need
# ARM translation and a different split policy.
#
# --chmod rather than RUN chmod: the base image is an Android system, not a
# Linux distribution, and has no /bin/sh for a RUN layer to use.
COPY --chmod=0755 bin/magnemite-agent-linux-arm64 /system/bin/magnemite-agent
COPY --chmod=0755 redroid/magnemite-start.sh /system/bin/magnemite-start.sh

# init reads every .rc under this directory at boot.
COPY --chmod=0644 redroid/magnemite.rc /system/etc/init/magnemite.rc
