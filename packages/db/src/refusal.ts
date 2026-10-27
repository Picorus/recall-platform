// A rule refusing a request (a screen in repair cannot be fitted, …): the reason is for the person
// who asked, not a fault. The API answers these 400 with the message; every other error is a 500.
export class Refusal extends Error {
  override readonly name = 'Refusal';
  constructor(
    message: string,
    /**
     * For apps that show it in the person's own language (P4.1): a fixed code for the reason, and
     * a number in it (tries left, minutes to wait).
     */
    readonly why?: { readonly code: string; readonly n?: number },
  ) {
    super(message);
  }
}
