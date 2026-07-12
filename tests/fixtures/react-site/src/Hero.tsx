import { CustomButton } from './CustomButton';

interface HeroProps {
  title: string;
}

export function Hero({ title }: HeroProps) {
  return (
    <section className="hero">
      <h1>{title}</h1>
      <p className="subtitle">Click any element to leave feedback.</p>
      <CustomButton label="Get Started" />
      <>
        <span>Fragment child</span>
      </>
    </section>
  );
}
