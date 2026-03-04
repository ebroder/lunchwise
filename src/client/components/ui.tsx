import { ComponentProps } from "preact";

// -- Button ------------------------------------------------------------------

type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive";

const buttonStyles: Record<ButtonVariant, string> = {
  primary:
    "bg-stone-900 dark:bg-white text-white dark:text-stone-900 px-6 py-2 rounded-lg text-sm font-medium hover:bg-stone-800 dark:hover:bg-stone-200 transition-colors cursor-pointer disabled:opacity-50",
  secondary:
    "text-sm text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100 px-3 py-1 rounded border border-stone-300 dark:border-stone-700 hover:border-stone-400 dark:hover:border-stone-500 transition-colors cursor-pointer disabled:opacity-50",
  ghost:
    "text-sm text-stone-600 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100 transition-colors cursor-pointer",
  destructive:
    "text-sm text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300 transition-colors cursor-pointer",
};

interface ButtonProps extends ComponentProps<"button"> {
  variant?: ButtonVariant;
}

export function Button({ variant = "primary", class: className, ...props }: ButtonProps) {
  return (
    <button {...props} class={`${buttonStyles[variant]}${className ? ` ${className}` : ""}`} />
  );
}

// -- Style constants ---------------------------------------------------------

export const card =
  "bg-white dark:bg-stone-900 rounded-lg border border-stone-200 dark:border-stone-800";

export const inputClass =
  "w-full rounded-lg border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-800 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-stone-900 dark:focus:ring-stone-400 focus:border-transparent";

export const labelClass = "block text-sm font-medium text-stone-700 dark:text-stone-300 mb-1";

export const alertSuccess =
  "bg-green-50 dark:bg-green-950/50 border border-green-200 dark:border-green-800 text-green-700 dark:text-green-300 rounded-lg px-4 py-3 mb-6 text-sm";

export const alertError =
  "bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 rounded-lg px-4 py-3 mb-6 text-sm";
