/** Ambient declarations for non-TS assets imported by the client bundle. */

declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

declare module '*.css' {
  const content: string
  export default content
}
