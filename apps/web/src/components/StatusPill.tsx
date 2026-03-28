type Props = {
  label: string;
  tone: "neutral" | "success" | "danger" | "accent";
};

export function StatusPill({ label, tone }: Props) {
  return <span className={`status-pill status-pill--${tone}`}>{label}</span>;
}
