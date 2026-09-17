import { AppError, SourceError } from "../errors.js";
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
export type FileUpload = { field: string; artifactHash: string; filename: string; mimeType: string; /** Local artifact path the browser must upload; absent for in-process adapters. */ localPath?: string };
export type PreparedForm = { filled: { field: string; value: string }[]; uploads: FileUpload[]; missing: string[]; note?: string };

/** What the page actually shows after filling: evidence, not the values the adapter intended. */
export type UploadedFile = { field: string; fileName: string; sizeBytes: number };
export type ObservedForm = { finalUrl: string; filled: { field: string; value: string }[]; uploads: UploadedFile[] };
export type SubmitConfirmation = { finalUrl: string; confirmationText: string | null; externalId: string | null; /** The site's own verdict, if it states one. */ result: string | null };
/**
 * The result of a send. `unknown` is the honest answer when the site's response cannot be
 * read reliably: never report success from an assumption. A pre-send failure throws.
 */
export type SubmitOutcome = { outcome: "submitted" | "rejected" | "unknown"; confirmationText?: string | null;
  confirmationImage?: Uint8Array | null; externalId?: string | null; detail?: string };

/**
 * Browser seam. A real implementation drives the supervised browser; unit tests supply a
 * fake. `clickPreview` must target the site's own non-submitting validation control and
 * must never press submit — submission is a separate, later capability.
 */
export interface FormSession {
  open(url: string, options: { allowPrivate: boolean; timeoutMs: number }): Promise<FormInspection & { pageUrl: string }>;
  fill(field: string, value: string): Promise<void>;
  uploadFile(field: string, filePath: string): Promise<void>;
  observe(): Promise<ObservedForm>;
  clickPreview(): Promise<boolean>;
  /**
   * Presses the site's real submit control. Called only by the submission service. Throw
   * `NothingSentError` only for a failure known to precede the press.
   */
  submitForm(): Promise<SubmitConfirmation>;
  screenshot(): Promise<Uint8Array>;
  close(): Promise<void>;
}
export type ApplicationContext = { http: HttpClient; allowPrivate: boolean; session?: FormSession };

export interface ApplicationAdapter {
  readonly id: string;
  readonly version: string;
  readonly capabilities: ApplicationCapabilities;
  inspect(formUrl: string, context: ApplicationContext): Promise<FormInspection>;
  prepare(input: { inspection: FormInspection; answers: Record<string, string>; resume: FileUpload }, context: ApplicationContext): Promise<PreparedForm>;
  /**
   * Performs the external send. Adapters whose `capabilities.submit` is false must refuse.
   * Report `unknown` when the site's response cannot be read reliably (a crash or timeout
   * after the send began is genuinely ambiguous); throw only when nothing was sent. For
   * session-backed adapters the service enforces this: a throw after `submitForm` was called
   * is recorded as unknown unless it is a `NothingSentError`. An adapter that sends without
   * the session must classify its own failures.
   */
  submit(input: { attemptId: string; formUrl: string; idempotencyKey: string; answers: Record<string, string>; resume: FileUpload }, context: ApplicationContext): Promise<SubmitOutcome>;
}

/** Manual handoff: it never pretends to fill a form. */
export class ManualApplicationAdapter implements ApplicationAdapter {
  readonly id = "manual";
  readonly version = "1";
  readonly capabilities: ApplicationCapabilities = { prepare: false, fill: false, upload: false, submit: false, reconcile: false };
  async inspect(): Promise<FormInspection> { throw new AppError("unsupported_capability", "Manual handoff has no form automation", 409); }
  async prepare(): Promise<PreparedForm> { throw new AppError("unsupported_capability", "Manual handoff has no form automation", 409); }
  async submit(): Promise<SubmitOutcome> { throw new AppError("unsupported_capability", "A manual handoff never sends anything", 409); }
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
  async submit(): Promise<SubmitOutcome> { throw new AppError("unsupported_capability", "The fixture adapter prepares in process and never sends", 409); }
}

type Factory = (options?: Record<string, unknown>) => ApplicationAdapter;
/** Fills a live form from the recorded answers, uploading the resume by its verified path. */
async function fillLiveForm(session: FormSession, fields: FormField[], answers: Record<string, string>, resume: FileUpload): Promise<PreparedForm> {
  const intended: PreparedForm = { filled: [], uploads: [], missing: [] };
  for (const field of fields) {
    if (field.type === "hidden") continue;
    if (field.type === "file") {
      if (field.name === resume.field) {
        if (!resume.localPath) { intended.missing.push(field.name); continue; }
        await session.uploadFile(field.name, resume.localPath);
        intended.uploads.push(resume);
      } else if (field.required) intended.missing.push(field.name);
      continue;
    }
    const raw = answers[field.name];
    if (raw === undefined || raw === "") { if (field.required) intended.missing.push(field.name); continue; }
    if (field.type === "select" && field.options && !field.options.includes(raw)) { intended.missing.push(field.name); continue; }
    await session.fill(field.name, field.type === "checkbox" ? "true" : raw);
    intended.filled.push({ field: field.name, value: raw });
  }
  return intended;
}

/** A browser-backed adapter over an injected `FormSession`; it needs the supervised browser. */
export class FixtureFormAdapter implements ApplicationAdapter {
  readonly id = "fixture-form";
  readonly version = "1";
  readonly capabilities: ApplicationCapabilities = { prepare: true, fill: true, upload: true, submit: true, reconcile: false };
  async inspect(formUrl: string, context: ApplicationContext): Promise<FormInspection> {
    const session = requireSession(context);
    const opened = await session.open(formUrl, { allowPrivate: context.allowPrivate, timeoutMs: 20_000 });
    return { formUrl, finalUrl: opened.pageUrl, fields: opened.fields, captcha: opened.captcha, automationForbidden: opened.automationForbidden };
  }
  async prepare(input: { inspection: FormInspection; answers: Record<string, string>; resume: FileUpload }, context: ApplicationContext): Promise<PreparedForm> {
    const session = requireSession(context);
    const intended = await fillLiveForm(session, input.inspection.fields, input.answers, input.resume);
    // A partial form is never presented as ready, and a preview is never triggered for one.
    if (intended.missing.length) return intended;
    const observed = await session.observe(); // report what the page shows, not what we typed
    await session.clickPreview();             // the site's own validation control, never submit
    return { filled: observed.filled, uploads: intended.uploads, missing: [] };
  }
  /** The only code path that presses submit, and only the submission service calls it. */
  async submit(input: { attemptId: string; formUrl: string; idempotencyKey: string; answers: Record<string, string>; resume: FileUpload }, context: ApplicationContext): Promise<SubmitOutcome> {
    const session = requireSession(context);
    // Sending is a fresh, complete submission: fill the live form again, then press submit.
    const opened = await session.open(input.formUrl, { allowPrivate: context.allowPrivate, timeoutMs: 20_000 });
    // A site that now blocks automation is a pre-send refusal: nothing was sent.
    if (opened.captcha) throw new SourceError("submit_blocked", "The site now presents a CAPTCHA; nothing was sent", false);
    if (opened.automationForbidden) throw new SourceError("submit_blocked", "The site now forbids automation; nothing was sent", false);
    const intended = await fillLiveForm(session, opened.fields, input.answers, input.resume);
    if (intended.missing.length) throw new SourceError("unsupported_required_fields", `Required fields could not be filled: ${intended.missing.join(", ")}`, false);
    const confirmation = await session.submitForm();
    const image = await session.screenshot().catch(() => null);
    const text = confirmation.confirmationText?.trim() ?? null;
    // No readable confirmation is not a success: it is an unknown the operator must resolve.
    if (!text && !confirmation.externalId) return { outcome: "unknown", confirmationText: null, confirmationImage: image, detail: "The site showed no readable confirmation of the send" };
    // A site that says it rejected the application is believed.
    const rejected = confirmation.result?.toLowerCase() === "rejected";
    return { outcome: rejected ? "rejected" : "submitted", confirmationText: text, confirmationImage: image, externalId: confirmation.externalId,
      detail: rejected ? "The site reported the submission was rejected" : undefined };
  }
}
function requireSession(context: ApplicationContext): FormSession {
  if (!context.session) throw new AppError("session_unavailable", "This adapter needs the supervised browser session", 409);
  return context.session;
}

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
registerApplicationAdapter("fixture-form", () => new FixtureFormAdapter());
