/** A box, as the command palette searches and opens it. */
export type PaletteBox = {
  id: string;
  name: string;
  serial: string;
  model: string | null;
  groupName: string | null;
  online: boolean;
  approved: boolean;
  /** Matched in Rotom, so its scanner page has something on it. */
  hasRotom: boolean;
  /** Whether its agent knows `collect_screenshot`. */
  canScreenshot: boolean;
};

/** A machine running Redroid containers. Opened on its own page, nothing deeper. */
export type PaletteHost = { id: string; name: string; online: boolean };

/** What `/api/palette` answers. */
export type PaletteData = { boxes: PaletteBox[]; hosts: PaletteHost[] };
