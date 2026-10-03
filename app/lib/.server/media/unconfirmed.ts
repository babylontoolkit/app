/**
 * The `finishReason` that marks a media render the provider may be running with no task we can poll
 * (`_specs/no-unbilled-usage_plan.md` D9): an ambiguous create, or a task record that could not be stored.
 * Its debit stands; the Admin usage report lists these rows for an operator to reconcile.
 *
 * Its own module so the admin report can read it without importing the media service.
 */
export const MEDIA_UNCONFIRMED_REASON = 'media-unconfirmed';
