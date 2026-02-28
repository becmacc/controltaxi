
import React from 'react';
import { Loader2 } from 'lucide-react';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'outline' | 'danger' | 'gold';
  size?: 'sm' | 'md' | 'lg';
  isLoading?: boolean;
}

export const Button: React.FC<ButtonProps> = ({ 
  children, 
  variant = 'primary', 
  size = 'md', 
  className = '', 
  isLoading = false,
  disabled,
  ...props 
}) => {
  const baseStyles = "inline-flex items-center justify-center rounded-lg font-bold transition-all active:scale-95 focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 disabled:pointer-events-none shadow-sm uppercase tracking-wide relative overflow-hidden";
  
  const variants = {
    primary: "bg-brand-900 text-gold-400 hover:bg-brand-800 focus:ring-brand-900 dark:bg-gold-600 dark:text-brand-950 dark:hover:bg-gold-500",
    gold: "bg-gold-600 text-brand-900 hover:bg-gold-700 focus:ring-gold-500 dark:bg-gold-500 dark:hover:bg-gold-400",
    secondary: "bg-slate-700 text-white hover:bg-slate-800 focus:ring-slate-700 dark:bg-brand-800 dark:hover:bg-brand-700",
    outline: "border-2 border-slate-200 bg-white text-brand-900 hover:bg-slate-50 focus:ring-brand-900 dark:bg-transparent dark:border-brand-800 dark:text-gold-400 dark:hover:bg-brand-900",
    danger: "bg-red-600 text-white hover:bg-red-700 focus:ring-red-500",
  };

  const sizes = {
    sm: "h-9 px-3 text-[11px]",
    md: "h-11 px-5 py-2 text-xs",
    lg: "h-14 px-8 text-sm",
  };

  return (
    <button 
      className={`${baseStyles} ${variants[variant]} ${sizes[size]} ${className}`} 
      disabled={isLoading || disabled}
      {...props}
    >
      {isLoading && (
        <Loader2 className="w-4 h-4 mr-2 animate-spin absolute left-4" />
      )}
      <span className={isLoading ? 'opacity-0' : 'opacity-100 flex items-center'}>
        {children}
      </span>
      {isLoading && (
        <span className="flex items-center justify-center space-x-2">
           <Loader2 className="w-4 h-4 animate-spin" />
           <span className="ml-2">Processing...</span>
        </span>
      )}
    </button>
  );
};
