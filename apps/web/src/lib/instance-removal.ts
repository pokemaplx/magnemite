/**
 * What taking a Redroid instance away does, worded once for both places it can
 * be done from: the machine's instance table and the box's own page. The two
 * verbs are different operations, and the confirmation is where that is said.
 */
export const REMOVE_INSTANCE_DESCRIPTION =
  "The container goes. Its volume and the box's row stay, so re-adding this index brings the same box back with everything it had. Any job it is running is cancelled first.";

export const FORGET_INSTANCE_DESCRIPTION =
  "The container, its /data volume and the box's row all go. Its history, its name and its identity go with them, and re-adding this index later creates a new box.";
