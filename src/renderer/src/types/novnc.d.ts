// @types/novnc__novnc only declares '@novnc/novnc/lib/rfb', but noVNC 1.7 exports only the bare
// specifier. Re-export the typed class under the name that actually resolves.
declare module '@novnc/novnc' {
  import RFB from '@novnc/novnc/lib/rfb'
  export default RFB
}
