declare module 'ovenplayer' {
  const OvenPlayer: { create(id: string, options: Record<string, unknown>): unknown };
  export default OvenPlayer;
}
