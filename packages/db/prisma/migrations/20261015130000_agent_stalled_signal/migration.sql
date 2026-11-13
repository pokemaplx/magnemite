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

ALTER TYPE "MonitorSignal" ADD VALUE 'AGENT_STALLED' AFTER 'AGENT_OFFLINE';
