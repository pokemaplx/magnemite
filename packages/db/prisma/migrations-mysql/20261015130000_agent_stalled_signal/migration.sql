-- A box that is connected and has stopped reporting, as its own fault.
--
-- Split out of AGENT_OFFLINE rather than folded into it, because the two have
-- opposite remediations and `rulesFor` dedupes on the signal, so they could
-- not have been two rules on one signal. A box that is simply gone can only be
-- announced; a box holding an open socket can be sent an exec, a restart or a
-- reboot, and that is the first fault class here whose remedy was both
-- available and unreachable.
--
-- The seed for it is written disabled, like every other, so an upgrade changes
-- nothing until somebody turns it on.
--
-- This provider spells the enum inline on every column that uses it, so both
-- have to be rewritten whole, in the order the schema declares them.

ALTER TABLE `MonitorRule` MODIFY `signal` ENUM('AGENT_OFFLINE', 'AGENT_STALLED', 'SERVICE_DOWN', 'APP_NOT_FOREGROUND', 'APP_ANR', 'HEALTH_CHECK_FAILED', 'LOOP_STALLED', 'ROTOM_DISCONNECTED', 'ROTOM_NOT_SCANNING', 'ROTOM_IDLE', 'DEVICE_MEMORY_LOW', 'DEVICE_STORAGE_LOW', 'DEVICE_TEMP_HIGH', 'HOST_DOCKER_DOWN', 'HOST_MEMORY_LOW', 'HOST_DISK_LOW', 'REDROID_INSTANCE_DOWN') NOT NULL;

ALTER TABLE `MonitorEvent` MODIFY `signal` ENUM('AGENT_OFFLINE', 'AGENT_STALLED', 'SERVICE_DOWN', 'APP_NOT_FOREGROUND', 'APP_ANR', 'HEALTH_CHECK_FAILED', 'LOOP_STALLED', 'ROTOM_DISCONNECTED', 'ROTOM_NOT_SCANNING', 'ROTOM_IDLE', 'DEVICE_MEMORY_LOW', 'DEVICE_STORAGE_LOW', 'DEVICE_TEMP_HIGH', 'HOST_DOCKER_DOWN', 'HOST_MEMORY_LOW', 'HOST_DISK_LOW', 'REDROID_INSTANCE_DOWN') NOT NULL;
