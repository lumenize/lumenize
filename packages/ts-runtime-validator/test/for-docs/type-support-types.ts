// Shared type definitions for type-support.mdx examples.
// Each section of the docs shows the relevant interface(s) from this file.

export interface Config {
  name: string;
  count: number;
  enabled: boolean;
  label: string | null;
  extra?: string;
}

export interface HasBigInt {
  value: bigint;
}

export interface Address {
  street: string;
  city: string;
}

export interface Person {
  name: string;
  address: Address;
}

export interface NumberList {
  items: number[];
}

export interface Result {
  value: string | number;
}

export interface User {
  name: string;
  nickname?: string;
}

export interface Scores {
  data: Map<string, number>;
}

export interface Mixed {
  data: Map<string, string | number>;
}

export interface Tags {
  items: Set<string>;
}

export interface Item {
  category: 'internal' | 'external';
}

export interface Appointment {
  when: Date;
}

export interface Pattern {
  re: RegExp;
}

export interface Link {
  url: URL;
}

export interface Req {
  headers: Headers;
}

export interface Failure {
  error: TypeError;
}

export interface AppError {
  name: string;
  message: string;
  statusCode: number;
}

export interface ErrorResult {
  error: AppError;
}

export interface BlobData {
  data: ArrayBuffer;
}

export interface Packet {
  bytes: Uint8Array;
}

export interface Flexible {
  metadata: any;
}

export interface Node {
  id: number;
  self: any;
}

