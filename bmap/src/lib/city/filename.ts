export function cityFilename(placeName: string): string {
  const s = placeName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return `cityglb-${s || "city"}.glb`;
}
