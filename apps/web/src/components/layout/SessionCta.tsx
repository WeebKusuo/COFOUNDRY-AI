import { homePathFor, useAuth } from '../../lib/auth';
import { ButtonLink, type ButtonVariant } from '../ui';

/** "Sign in" for visitors, "Open your workspace" once signed in. */
export function SessionCta({
  variant = 'primary',
  size = 'md',
  className,
}: {
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const { user } = useAuth();
  return user ? (
    <ButtonLink to={homePathFor(user)} variant={variant} size={size} className={className}>
      Open your workspace
    </ButtonLink>
  ) : (
    <ButtonLink to="/sign-in" variant={variant} size={size} className={className}>
      Sign in
    </ButtonLink>
  );
}
