declare module 'epg-parser' {
  export interface ParsedEPG {
    date?: string
    channels: unknown[]
    programs: unknown[]
  }

  export function parse(xml: string): ParsedEPG
  const epgParser: {
    parse: typeof parse
  }
  export default epgParser
}
