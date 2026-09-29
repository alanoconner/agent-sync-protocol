export interface DurabilityRequest {
  kind: "barrier";
  requestId: number;
}

export type DurabilityResponse =
  | { kind: "durable"; requestId: number; persistent: boolean }
  | { kind: "error"; requestId: number; message: string };
