/** Animated indicator with the current step of a running job. */
export function Progress({ text, className = '' }: { text: string; className?: string }) {
  return <p className={'job-progress ' + className} role="status"><span className="spinner" aria-hidden="true"/>{text}</p>;
}
