import { AppError } from "../errors.js";
import type { HttpClient } from "../net.js";

/**
 * Application-form adapter contract, on the same registry pattern as spawners and sources.
 * Preparing local materials never authorizes transmitting them: `submit` is a separate
 * capability, and step 9 never performs it. A real adapter drives a dedicated supervised
 * browser (see PERSONAS/README); the fixture adapter is deterministic and network-free
 * unless a context HTTP client is supplied.
 */
export type ApplicationCapabilities = { prepare: boolean; fill: boolean; upload: boolean; submit: boolean; reconcile: boolean };
export type FormFieldType = "text" | "email" | "tel" | "url" | "textarea" | "select" | "checkbox" | "file" | "hidden";
export type FormField = { name: string; label: string; type: FormFieldType; required: boolean; options?: string[]; accept?: string[] };
export type FormInspection = { formUrl: string; finalUrl: string; fields: FormField[]; captcha: boolean; automationForbidden: boolean };
export type FileUpload = { field: string; artifactHash: string; filename: string; mimeType: string };
export type PreparedForm = { filled: { field: string; value: string }[]; uploads: FileUpload[]; missing: string[]; note?: string };
export type ApplicationContext = { http: HttpClient; allowPrivate: boolean };

export interface ApplicationAdapter {
  readonly id: string;
  readonly version: string;
  readonly capabilities: ApplicationCapabilities;
  inspect(formUrl: string, context: ApplicationContext): Promise<FormInspection>;
  prepare(input: { inspection: FormInspection; answers: Record<string, string>; resume: FileUpload }, context: ApplicationContext): Promise<PreparedForm>;
}

/** Manual handoff: it never pretends to fill a form. */
export class ManualApplicationAdapter implements ApplicationAdapter {
  readonly id = "manual";
  readonly version = "1";
  readonly capabilities: ApplicationCapabilities = { prepare: false, fill: false, upload: false, submit: false, reconcile: false };
  async inspect(): Promise<FormInspection> { throw new AppError("unsupported_capability", "Manual handoff has no form automation", 409); }
  async prepare(): Promise<PreparedForm> { throw new AppError("unsupported_capability", "Manual handoff has no form automation", 409); }
}

const DEFAULT_FIELDS: FormField[] = [
  { name: "name", label: "Full name", type: "text", required: true },
  { name: "email", label: "Email", type: "email", required: true },
  { name: "phone", label: "Phone", type: "tel", required: false },
  { name: "linkedin", label: "LinkedIn", type: "url", required: false },
  { name: "resume", label: "Resume", type: "file", required: true, accept: ["application/pdf", "text/plain"] },
  { name: "coverLetter", label: "Cover letter", type: "textarea", required: false },
];

/** Deterministic fixture: fields and fault flags come from options, not the network. */
export class FixtureApplicationAdapter implements ApplicationAdapter {
  readonly id = "fixture";
  readonly version = "1";
  readonly capabilities: ApplicationCapabilities = { prepare: true, fill: true, upload: true, submit: false, reconcile: false };
  constructor(private readonly options: { fields?: FormField[]; captcha?: boolean; automationForbidden?: boolean; finalUrl?: string } = {}) {}
  async inspect(formUrl: string): Promise<FormInspection> {
    return {
      formUrl, finalUrl: this.options.finalUrl ?? formUrl,
      fields: this.options.fields ?? DEFAULT_FIELDS,
      captcha: this.options.captcha === true,
      automationForbidden: this.options.automationForbidden === true,
    };
  }
  async prepare(input: { inspection: FormInspection; answers: Record<string, string>; resume: FileUpload }): Promise<PreparedForm> {
    const filled: PreparedForm["filled"] = [];
    const uploads: FileUpload[] = [];
    const missing: string[] = [];
    for (const field of input.inspection.fields) {
      if (field.type === "hidden") continue;
      if (field.type === "file") {
        if (field.name === input.resume.field) { uploads.push(input.resume); continue; }
        if (field.required) missing.push(field.name);
        continue;
      }
      const raw = input.answers[field.name];
      if (raw === undefined || raw === "") { if (field.required) missing.push(field.name); continue; }
      if (field.type === "select" && field.options && !field.options.includes(raw)) { missing.push(field.name); continue; }
      filled.push({ field: field.name, value: raw });
    }
    return { filled, uploads, missing };
  }
}

type Factory = (options?: Record<string, unknown>) => ApplicationAdapter;
const factories = new Map<string, Factory>();
export function registerApplicationAdapter(id: string, factory: Factory): void { factories.set(id, factory); }
export function applicationAdapterIds(): string[] { return [...factories.keys()].sort(); }
export function createApplicationAdapter(id: string, options?: Record<string, unknown>): ApplicationAdapter {
  const factory = factories.get(id);
  if (!factory) throw new AppError("unknown_adapter", `No application adapter is registered as ${id}`);
  return factory(options);
}
registerApplicationAdapter("manual", () => new ManualApplicationAdapter());
registerApplicationAdapter("fixture", options => new FixtureApplicationAdapter(options as ConstructorParameters<typeof FixtureApplicationAdapter>[0]));
