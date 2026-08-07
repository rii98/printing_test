/**
 * The neutral document model. Layouts build a Doc (a list of ops); encoders turn
 * a Doc into either ESC/POS bytes (real printing) or plain text (preview + tests).
 * Keeping this middle layer means layouts are tested as data, and adding a new
 * output (PDF, HTML) is just another encoder — no layout changes.
 *
 * @typedef {{bold?:boolean,doubleH?:boolean,doubleW?:boolean,invert?:boolean}} Style
 * @typedef {{t:'align',v:'left'|'center'|'right'}} OpAlign
 * @typedef {{t:'text',v:string,s?:Style}} OpText
 * @typedef {{t:'rule',ch?:string}} OpRule
 * @typedef {{t:'row',left:string,right:string,s?:Style}} OpRow
 * @typedef {{t:'feed',n?:number}} OpFeed
 * @typedef {{t:'qr',v:string}} OpQr
 * @typedef {{t:'cut'}} OpCut
 * @typedef {{t:'drawer'}} OpDrawer
 * @typedef {OpAlign|OpText|OpRule|OpRow|OpFeed|OpQr|OpCut|OpDrawer} Op
 * @typedef {Op[]} Doc
 */

/** Small fluent builder so layouts read top-to-bottom. */
export class DocBuilder {
  constructor() { /** @type {import('./doc.js').Doc} */ this.ops = []; }
  align(v) { this.ops.push({ t: 'align', v }); return this; }
  text(v = '', s) { this.ops.push({ t: 'text', v: String(v), s }); return this; }
  rule(ch = '-') { this.ops.push({ t: 'rule', ch }); return this; }
  row(left, right, s) { this.ops.push({ t: 'row', left: String(left), right: String(right), s }); return this; }
  feed(n = 1) { this.ops.push({ t: 'feed', n }); return this; }
  qr(v) { this.ops.push({ t: 'qr', v: String(v) }); return this; }
  cut() { this.ops.push({ t: 'cut' }); return this; }
  drawer() { this.ops.push({ t: 'drawer' }); return this; }
  build() { return this.ops; }
}
