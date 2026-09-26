import { AuthShell } from "@/layouts/AuthShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NoticeState } from "@/components/States";
import { useAuth } from "@/hooks/use-auth";
import { authErrorMessage, signUp } from "@/services/auth";
import { CheckCircle2, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useForm, useWatch } from "react-hook-form";

interface SignupValues {
  name: string;
  email: string;
  password: string;
  confirmPassword: string;
}

export default function Signup() {
  const { isLoading: authLoading, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const returnTo = searchParams.get("returnTo");
  const redirect =
    returnTo && returnTo.startsWith("/") && !returnTo.startsWith("//")
      ? returnTo
      : "/dashboard";

  const [formError, setFormError] = useState<string | null>(null);
  const [needsEmailConfirmation, setNeedsEmailConfirmation] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
  } = useForm<SignupValues>({
    defaultValues: { name: "", email: "", password: "", confirmPassword: "" },
  });

  const password = useWatch({ control, name: "password" });

  useEffect(() => {
    if (!authLoading && isAuthenticated) {
      navigate(redirect, { replace: true });
    }
  }, [authLoading, isAuthenticated, navigate, redirect]);

  async function onSubmit(values: SignupValues) {
    setIsSubmitting(true);
    setFormError(null);
    try {
      const { needsEmailConfirmation: needsConfirm } = await signUp({
        email: values.email,
        password: values.password,
        name: values.name,
      });

      if (needsConfirm) {
        setNeedsEmailConfirmation(true);
        setIsSubmitting(false);
      }
      // Otherwise the auth listener flips `isAuthenticated` and the effect redirects.
    } catch (error) {
      setFormError(authErrorMessage(error));
      setIsSubmitting(false);
    }
  }

  return (
    <AuthShell
      title="Create your account"
      subtitle="Join HackSim and start training for the real event."
      footer={
        <span>
          Already have an account?{" "}
          <Link
            to="/login"
            className="font-medium text-foreground underline underline-offset-4"
          >
            Sign in
          </Link>
        </span>
      }
    >
      {needsEmailConfirmation ? (
        <div className="flex flex-col items-start gap-4 rounded-lg border border-border bg-secondary/40 p-6">
          <div className="grid size-9 place-items-center rounded-full bg-background">
            <CheckCircle2 className="size-4 text-signal" />
          </div>
          <div>
            <p className="text-sm font-semibold">Check your inbox</p>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
              We sent a confirmation link to your email. Confirm your address,
              then sign in to continue.
            </p>
          </div>
          <Button variant="outline" size="sm" asChild>
            <Link to="/login">Go to sign in</Link>
          </Button>
        </div>
      ) : (
        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-5">
          {formError && (
            <NoticeState title="Couldn't create account" message={formError} />
          )}

          <div className="flex flex-col gap-2">
            <Label htmlFor="name">Full name</Label>
            <Input
              id="name"
              autoComplete="name"
              placeholder="Ada Lovelace"
              {...register("name", {
                required: "Name is required",
                minLength: {
                  value: 2,
                  message: "Name must be at least 2 characters",
                },
              })}
            />
            {errors.name && (
              <p className="text-xs text-destructive">{errors.name.message}</p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              {...register("email", {
                required: "Email is required",
                pattern: {
                  value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
                  message: "Enter a valid email address",
                },
              })}
            />
            {errors.email && (
              <p className="text-xs text-destructive">
                {errors.email.message}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              placeholder="At least 6 characters"
              {...register("password", {
                required: "Password is required",
                minLength: {
                  value: 6,
                  message: "Password must be at least 6 characters",
                },
              })}
            />
            {errors.password && (
              <p className="text-xs text-destructive">
                {errors.password.message}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="confirmPassword">Confirm password</Label>
            <Input
              id="confirmPassword"
              type="password"
              autoComplete="new-password"
              placeholder="Repeat your password"
              {...register("confirmPassword", {
                required: "Please confirm your password",
                validate: (value) =>
                  value === password || "Passwords do not match",
              })}
            />
            {errors.confirmPassword && (
              <p className="text-xs text-destructive">
                {errors.confirmPassword.message}
              </p>
            )}
          </div>

          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting && <Loader2 className="size-4 animate-spin" />}
            {isSubmitting ? "Creating account" : "Create account"}
          </Button>
        </form>
      )}
    </AuthShell>
  );
}
