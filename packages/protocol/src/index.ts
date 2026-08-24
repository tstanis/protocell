/**
 * @protocell/protocol — the wire contract between the sim server and its clients.
 * SPEC.md §15.3.
 */

export {
  PROTOCOL_VERSION,
  type ClientMsg,
  type Command,
  type EventKind,
  type EventMsg,
  type HelloMsg,
  type ScalarsMsg,
  type ServerMsg,
  type ViewSpec,
} from './messages.js';

export {
  HEADER_FIXED_BYTES,
  MAGIC,
  decodeFieldFrame,
  downsample,
  encodeFieldFrame,
  type FieldFrame,
} from './codec.js';
