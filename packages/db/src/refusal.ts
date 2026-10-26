// A rule refusing a request (a screen in repair cannot be fitted, …): the reason is for the person
// who asked, not a fault. The API answers these 400 with the message; every other error is a 500.
export class Refusal extends Error {
  override readonly name = 'Refusal';
}
