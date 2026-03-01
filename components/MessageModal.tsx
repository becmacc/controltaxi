
import React, { useState, useEffect } from 'react';
import { X, Copy, Check, Send, MessageCircle } from 'lucide-react';
import { Button } from './ui/Button';
import { buildWhatsAppLink, sanitizeCommunicationText } from '../services/whatsapp';
import { CustomerSnapshot } from '../services/customerSnapshot';
import { CustomerSnapshotCard } from './CustomerSnapshotCard';

interface MessageModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  initialMessage: string;
  onMarkSent: (finalMessage: string) => void;
  recipientPhone?: string;
  operatorPhone?: string;
  customerSnapshot?: CustomerSnapshot;
}

export const MessageModal: React.FC<MessageModalProps> = ({ 
  isOpen, 
  onClose, 
  title, 
  initialMessage, 
  onMarkSent,
  recipientPhone,
  operatorPhone,
  customerSnapshot,
}) => {
  const [message, setMessage] = useState(initialMessage);
  const [copied, setCopied] = useState(false);
  const [deliverySignal, setDeliverySignal] = useState(false);

  useEffect(() => {
    setMessage(initialMessage);
    setDeliverySignal(false);
  }, [initialMessage]);

  if (!isOpen) return null;

  const handleCopy = () => {
    navigator.clipboard.writeText(sanitizeCommunicationText(message));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const whatsAppLink = recipientPhone ? buildWhatsAppLink(recipientPhone, message) : null;
  const operatorWhatsAppLink = operatorPhone ? buildWhatsAppLink(operatorPhone, message) : null;

  const handleWhatsApp = () => {
    if (!whatsAppLink) return;
    const openedWindow = window.open(whatsAppLink, '_blank', 'noopener,noreferrer');
    if (openedWindow) {
      setDeliverySignal(true);
    }
  };

  const handleOperatorWhatsApp = () => {
    if (!operatorWhatsAppLink) return;
    const openedWindow = window.open(operatorWhatsAppLink, '_blank', 'noopener,noreferrer');
    if (openedWindow) {
      setDeliverySignal(true);
    }
  };

  const hasWhatsAppTarget = Boolean(whatsAppLink || operatorWhatsAppLink);

  return (
    <div className="fixed inset-0 bg-brand-950/80 backdrop-blur-md z-[200] flex items-center justify-center p-3 md:p-4 overflow-y-auto">
      <div className="bg-white dark:bg-brand-900 rounded-[2rem] md:rounded-[2.5rem] shadow-2xl w-full max-w-md max-h-[calc(100dvh-1.5rem)] md:max-h-[calc(100dvh-2rem)] border border-slate-200 dark:border-brand-800 animate-in zoom-in-95 duration-200 flex flex-col overflow-hidden">
        <div className="px-8 py-6 bg-slate-50 dark:bg-brand-950 border-b dark:border-brand-800 flex justify-between items-center">
          <div>
            <h3 className="font-black text-brand-900 dark:text-slate-100 uppercase tracking-tight text-lg">{title}</h3>
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-0.5">Customer Communication</p>
          </div>
          <button onClick={onClose} className="p-2 text-slate-400 hover:text-red-500 transition-colors"><X size={24}/></button>
        </div>
        
        <div className="p-5 md:p-8 overflow-y-auto min-h-0 flex-1 pb-[calc(1.25rem+env(safe-area-inset-bottom))] md:pb-8">
          {customerSnapshot && (
            <CustomerSnapshotCard snapshot={customerSnapshot} className="mb-4" />
          )}
          <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest block mb-2 px-1">Message Preview</label>
          <textarea 
            value={message} 
            onChange={(e) => setMessage(e.target.value)}
            className="w-full h-40 md:h-48 border border-slate-200 dark:border-brand-800 rounded-2xl p-4 bg-slate-50 dark:bg-brand-950 text-slate-900 dark:text-slate-100 text-sm font-medium focus:ring-2 focus:ring-gold-500 outline-none transition-all resize-none"
          />
          {hasWhatsAppTarget && !deliverySignal && (
            <p className="mt-3 text-[9px] font-black uppercase tracking-widest text-amber-600 dark:text-amber-400">
              WhatsApp not opened yet. You can still mark as sent manually.
            </p>
          )}
        </div>

        <div className="px-5 md:px-8 py-4 md:py-6 bg-slate-50 dark:bg-brand-950 border-t dark:border-brand-800 grid grid-cols-4 gap-2 md:gap-3 pb-[max(1rem,env(safe-area-inset-bottom))] md:pb-6">
          <Button variant="outline" onClick={handleCopy} className="w-full h-12 px-1.5 bg-white text-[10px] tracking-widest" title={copied ? 'Copied' : 'Copy'}>
            {copied ? <Check size={15} className="mr-1.5" /> : <Copy size={15} className="mr-1.5" />}
            <span>{copied ? 'OK' : 'CPY'}</span>
          </Button>
          <Button variant="outline" onClick={handleWhatsApp} disabled={!whatsAppLink} className="w-full h-12 px-1.5 bg-white text-[10px] tracking-widest" title="Customer WhatsApp">
            <MessageCircle size={15} className="mr-1.5" />
            <span>WA</span>
          </Button>
          <Button variant="outline" onClick={handleOperatorWhatsApp} disabled={!operatorWhatsAppLink} className="w-full h-12 px-1.5 bg-white text-[10px] tracking-widest" title="Operator WhatsApp">
            <MessageCircle size={15} className="mr-1.5" />
            <span>OP</span>
          </Button>
          <Button onClick={() => onMarkSent(sanitizeCommunicationText(message))} variant="gold" className="w-full h-12 px-1.5 text-[10px] tracking-widest" title="Mark Sent">
            <Send size={15} className="mr-1.5" />
            <span>SENT</span>
          </Button>
        </div>
      </div>
    </div>
  );
};
