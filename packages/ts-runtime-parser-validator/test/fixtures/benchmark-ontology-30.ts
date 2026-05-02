/**
 * Benchmark ontology — 30 resource types, Nebula-shaped.
 *
 * Design targets (per Phase 6 Work):
 *   - 30 top-level interfaces
 *   - Average ~6 fields per type (range 4–9)
 *   - Nesting depth ~3 levels (relationship chains of at least 3 hops)
 *   - Average ~2 cross-references per type (mix of one/many/Set/Map)
 *
 * Exercises typia's full feature set so the generated-module size is
 * representative of real usage:
 *   - Primitives, unions, optionals
 *   - JSDoc tags: @minimum, @maximum, @minLength, @maxLength, @pattern,
 *     @format (email/uuid/url/date-time), @default
 *   - Relationships: `T`, `T | null`, `T[]`, `Set<T>`, `Map<K, T>`
 *
 * Exported as a string so tests can pass it directly to
 * `generateParseModule()` / `extractTypeMetadata()`. See
 * `test/benchmark-size.test.ts` for the consumer.
 *
 * Kept hand-authored (not generated) for reproducibility — the emitted
 * module size and compile behaviour should be stable across runs.
 */
export const BENCHMARK_ONTOLOGY_30 = `
// ========================================================================
// Identity / organisation layer (7 types)
// ========================================================================
interface User {
  id: string;
  /** @format email */
  email: string;
  /** @minLength 1 @maxLength 100 */
  name: string;
  /** @default "active" */
  status?: "active" | "suspended" | "invited";
  /** @format date-time */
  createdAt: string;
  avatar: File | null;
  roles: Set<Role>;
}

interface Team {
  id: string;
  /** @minLength 1 */
  name: string;
  /** @default "" */
  description?: string;
  members: Set<User>;
  lead: User;
  organization: Organization;
}

interface Organization {
  id: string;
  /** @minLength 1 */
  name: string;
  /** @format url */
  website: string;
  owner: User;
  /** @default 0 */
  seatCount?: number;
  billing: BillingPlan | null;
}

interface Role {
  id: string;
  /** @pattern ^[a-z][a-z0-9-]*$ */
  slug: string;
  label: string;
  permissions: Set<Permission>;
  /** @default false */
  isBuiltin?: boolean;
}

interface Permission {
  id: string;
  /** @pattern ^[a-z]+:[a-z]+$ */
  key: string;
  label: string;
}

interface AccessGrant {
  id: string;
  subject: User;
  role: Role;
  scope: "org" | "team" | "project";
  /** @format date-time */
  grantedAt: string;
}

interface BillingPlan {
  id: string;
  tier: "free" | "pro" | "enterprise";
  /** @minimum 0 */
  seatPrice: number;
  /** @default 1 */
  seats?: number;
}

// ========================================================================
// Project / planning layer (6 types)
// ========================================================================
interface Project {
  id: string;
  /** @minLength 1 @maxLength 200 */
  name: string;
  team: Team;
  status: "active" | "archived" | "draft";
  milestones: Milestone[];
  /** @default [] */
  tags?: string[];
  /** @format date-time */
  createdAt: string;
}

interface Milestone {
  id: string;
  project: Project;
  name: string;
  /** @format date-time */
  dueDate: string;
  sprints: Sprint[];
  /** @default 0 */
  progress?: number;
}

interface Sprint {
  id: string;
  milestone: Milestone;
  /** @minLength 1 */
  name: string;
  /** @format date-time */
  startsAt: string;
  /** @format date-time */
  endsAt: string;
  tasks: Task[];
}

interface Workflow {
  id: string;
  name: string;
  states: Map<string, Status>;
  /** @default {} */
  transitions?: Record<string, string[]>;
}

interface Status {
  id: string;
  /** @pattern ^[a-z-]+$ */
  slug: string;
  label: string;
  /** @pattern ^#[0-9a-fA-F]{6}$ */
  color: string;
}

interface Category {
  id: string;
  name: string;
  /** @default null */
  parent?: Category | null;
  labels: Set<Label>;
}

// ========================================================================
// Work-item layer (5 types)
// ========================================================================
interface Task {
  id: string;
  /** @minLength 1 @maxLength 500 */
  title: string;
  description: string;
  assignee: User | null;
  sprint: Sprint | null;
  status: Status;
  labels: Set<Label>;
  subtasks: Subtask[];
  /** @minimum 0 @maximum 100 */
  priority: number;
  /** @default [] */
  attachments?: Attachment[];
}

interface Subtask {
  id: string;
  parent: Task;
  title: string;
  /** @default false */
  done?: boolean;
}

interface Comment {
  id: string;
  author: User;
  task: Task;
  body: string;
  /** @format date-time */
  createdAt: string;
  mentions: Set<User>;
}

interface Attachment {
  id: string;
  file: File;
  task: Task;
  uploader: User;
  /** @minimum 0 */
  sizeBytes: number;
}

interface Label {
  id: string;
  /** @minLength 1 @maxLength 30 */
  name: string;
  /** @pattern ^#[0-9a-fA-F]{6}$ */
  color: string;
}

// ========================================================================
// Artifact layer (4 types)
// ========================================================================
interface File {
  id: string;
  /** @minLength 1 */
  name: string;
  folder: Folder | null;
  /** @format url */
  url: string;
  mimeType: string;
  /** @minimum 0 */
  size: number;
  /** @format uuid */
  checksum: string;
}

interface Folder {
  id: string;
  name: string;
  /** @default null */
  parent?: Folder | null;
  owner: User;
}

interface Asset {
  id: string;
  project: Project;
  file: File;
  kind: "image" | "video" | "document" | "other";
  /** @default {} */
  metadata?: Record<string, string | number | boolean>;
}

interface Dashboard {
  id: string;
  project: Project;
  name: string;
  widgets: Widget[];
  /** @default {} */
  layout?: Record<string, { x: number; y: number; w: number; h: number }>;
}

// ========================================================================
// Activity / notification layer (4 types)
// ========================================================================
interface Notification {
  id: string;
  recipient: User;
  subject: string;
  body: string;
  /** @default false */
  read?: boolean;
  /** @format date-time */
  createdAt: string;
  relatedTask: Task | null;
}

interface ActivityEvent {
  id: string;
  actor: User;
  kind: "created" | "updated" | "deleted" | "commented" | "assigned";
  /** @format date-time */
  occurredAt: string;
  /** @default {} */
  payload?: Record<string, string | number | boolean | null>;
  project: Project;
}

interface Widget {
  id: string;
  kind: "chart" | "list" | "counter" | "text";
  config: Record<string, string | number | boolean>;
  /** @default [] */
  datasource?: string[];
}

interface Report {
  id: string;
  project: Project;
  author: User;
  title: string;
  /** @format date-time */
  generatedAt: string;
  widgets: Widget[];
}

// ========================================================================
// Communication layer (4 types)
// ========================================================================
interface Channel {
  id: string;
  /** @pattern ^[a-z][a-z0-9-]*$ */
  slug: string;
  name: string;
  team: Team;
  members: Set<User>;
  threads: Thread[];
}

interface Thread {
  id: string;
  channel: Channel;
  starter: User;
  subject: string;
  messages: Message[];
  /** @default false */
  archived?: boolean;
}

interface Message {
  id: string;
  thread: Thread;
  author: User;
  body: string;
  /** @format date-time */
  sentAt: string;
  reactions: Map<string, number>;
}

interface Invitation {
  id: string;
  /** @format email */
  email: string;
  team: Team;
  inviter: User;
  /** @default "pending" */
  status?: "pending" | "accepted" | "revoked";
  /** @format date-time */
  expiresAt: string;
}
`;

/**
 * Descriptive numbers for test assertions.
 * These are updated when the ontology is tuned.
 */
export const BENCHMARK_30_STATS = {
  interfaceCount: 30,
  // Approximate; actual measured values recorded in the task file.
  estimatedFieldsTotal: 180,
};
