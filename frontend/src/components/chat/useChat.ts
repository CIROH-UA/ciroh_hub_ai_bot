import { useState, useEffect, useRef } from 'react';
import { Message, QuotaInfo } from './types';
import { chatAPI, ChatResponse, HistoryTurn, StreamUnavailableError } from '../../services/api';
import { trackEvent } from '../../services/telemetry';
import { clearEmail, getEmail, setEmail as storeEmail } from '../../services/user';
import {
  CAPTCHA_DISABLED,
  CaptchaConfig,
  CaptchaRequiredError,
  HumanPass,
  clearHumanPass,
  fetchCaptchaConfig,
  getHumanPass,
  isPassValid,
  setHumanPass as storeHumanPass,
} from '../../services/captcha';

const MESSAGES_KEY = 'ciroh_chat_messages';
const QUOTA_KEY = 'ciroh_chat_quota';

// Remembered so "N questions left today" survives a reload; ignored once the
// day changes (the server resets counts at midnight US Central).
function todayKey(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

function loadQuota(): QuotaInfo | null {
  try {
    const saved = JSON.parse(localStorage.getItem(QUOTA_KEY) || 'null');
    return saved && saved.day === todayKey() ? (saved.quota as QuotaInfo) : null;
  } catch {
    return null;
  }
}

function saveQuota(quota: QuotaInfo): void {
  try {
    localStorage.setItem(QUOTA_KEY, JSON.stringify({ day: todayKey(), quota }));
  } catch {
    // Ignore.
  }
}

function loadMessages(): Message[] {
  try {
    const raw = localStorage.getItem(MESSAGES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Array<Omit<Message, 'timestamp'> & { timestamp: string }>;
    return parsed
      // Drop an answer that was still streaming when the page was closed.
      .filter(msg => !(msg.isStreaming && !msg.text))
      .map(msg => ({ ...msg, isStreaming: false, status: undefined, timestamp: new Date(msg.timestamp) }));
  } catch {
    return [];
  }
}

function saveMessages(messages: Message[]): void {
  try {
    localStorage.setItem(MESSAGES_KEY, JSON.stringify(messages));
  } catch {
    // Ignore quota / private-mode failures.
  }
}

// Answers that aren't about the conversation's topic (greetings, refusals,
// limit / waking-up notices) are left out of the context sent back.
const NON_ANSWER_ROUTES = new Set(['help', 'rejected', 'limit', 'unavailable']);
const MAX_HISTORY_MESSAGES = 6; // the last 3 question/answer pairs
const MAX_HISTORY_CHARS = 2000;

/**
 * The conversation so far as question/answer pairs, for the API's `history`,
 * so a follow-up like "how do I install it?" is understood. Only completed,
 * real answers are included (they always carry a route); error messages,
 * greetings and refusals are skipped along with their question.
 */
export function buildHistory(messages: Message[]): HistoryTurn[] {
  const turns: HistoryTurn[] = [];
  messages.forEach((message, index) => {
    const reply = messages[index + 1];
    if (message.isBot || !message.text.trim() || !reply?.isBot) return;
    if (reply.isStreaming || !reply.text.trim() || !reply.route) return;
    if (NON_ANSWER_ROUTES.has(reply.route)) return;
    turns.push(
      { role: 'user', text: message.text.slice(0, MAX_HISTORY_CHARS) },
      { role: 'assistant', text: reply.text.slice(0, MAX_HISTORY_CHARS) }
    );
  });
  return turns.slice(-MAX_HISTORY_MESSAGES);
}

export function useChat() {
  const [messages, setMessages] = useState<Message[]>(() => loadMessages());
  const [inputValue, setInputValue] = useState('');
  const [isBotResponding, setIsBotResponding] = useState(false);
  const [showExamples, setShowExamples] = useState(() => loadMessages().length === 0);
  const [expandedCategories, setExpandedCategories] = useState<Set<number>>(
    new Set()
  );
  const [lastError, setLastError] = useState<string | null>(null);
  const [email, setEmailState] = useState<string | null>(() => getEmail());
  const [quota, setQuota] = useState<QuotaInfo | null>(() => loadQuota());
  const [captchaConfig, setCaptchaConfig] = useState<CaptchaConfig>(CAPTCHA_DISABLED);
  const [humanPass, setHumanPassState] = useState<HumanPass | null>(() => getHumanPass());
  /** Shown on the verification screen when the API asked to verify again. */
  const [captchaNotice, setCaptchaNotice] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const lastBotMessageRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to the start of the last bot message when it arrives
  useEffect(() => {
    const scrollToLastBotMessage = () => {
      if (lastBotMessageRef.current) {
        lastBotMessageRef.current.scrollIntoView({ 
          behavior: 'smooth',
          block: 'start'
        });
      } else if (messagesEndRef.current) {
        // Fallback to bottom if no bot message ref
        messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
      }
    };
    
    // Small delay to ensure DOM is updated
    const timeoutId = setTimeout(scrollToLastBotMessage, 100);
    
    return () => clearTimeout(timeoutId);
    // Not on every streamed word: that would yank the view while reading.
  }, [messages.length, isBotResponding]);

  useEffect(() => {
    saveMessages(messages);
  }, [messages]);

  // Ask the API whether visitors must pass the CAPTCHA.
  useEffect(() => {
    let cancelled = false;
    fetchCaptchaConfig().then(config => {
      if (!cancelled) setCaptchaConfig(config);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /** True while the visitor has an email but still has to pass the CAPTCHA. */
  const needsVerification = captchaConfig.enabled && !!email && !isPassValid(humanPass, email);

  // Hide examples when user starts chatting
  useEffect(() => {
    if (messages.length > 0) {
      setShowExamples(false);
    }
  }, [messages.length]);

  const handleSetEmail = (value: string, pass?: HumanPass | null) => {
    if (value !== email) {
      setQuota(null);
      trackEvent('email_provided');
    }
    storeEmail(value);
    setEmailState(value);
    if (pass) {
      storeHumanPass(pass);
      setHumanPassState(pass);
    }
    setCaptchaNotice(null);
  };

  const handleChangeEmail = () => {
    clearEmail();
    clearHumanPass();
    setEmailState(null);
    setHumanPassState(null);
    setQuota(null);
  };

  /** The API no longer accepts the pass (expired, rotated secret, CAPTCHA
   * newly switched on): send the visitor back to verify, keeping the email. */
  const requireVerification = (message: string) => {
    clearHumanPass();
    setHumanPassState(null);
    setCaptchaNotice(message);
    // The API said so, even if the config said CAPTCHA was off.
    setCaptchaConfig(config => (config.enabled ? config : { ...config, enabled: true }));
    fetchCaptchaConfig().then(config => {
      if (config.enabled) setCaptchaConfig(config);
    });
  };

  const handleSendMessage = async (text: string) => {
    if (!text.trim() || !email || isBotResponding || needsVerification) return;
    const pass = humanPass && humanPass.email === email ? humanPass.pass : null;
    // Captured before this question is added to the conversation.
    const history = buildHistory(messages);

    const userMessage: Message = {
      id: Date.now().toString(),
      text: text.trim(),
      isBot: false,
      timestamp: new Date(),
    };

    setMessages(prev => [...prev, userMessage]);
    setInputValue('');
    setIsBotResponding(true);
    setLastError(null);
    trackEvent('question_asked', { length: text.trim().length });

    const botId = (Date.now() + 1).toString();
    const updateBot = (patch: (msg: Message) => Partial<Message>) =>
      setMessages(prev => prev.map(msg => (msg.id === botId ? { ...msg, ...patch(msg) } : msg)));

    setMessages(prev => [
      ...prev,
      {
        id: botId,
        text: '',
        isBot: true,
        timestamp: new Date(),
        isStreaming: true,
        status: 'Thinking...',
      },
    ]);

    let streamed = true;
    let response: ChatResponse;
    try {
      try {
        response = await chatAPI.streamQuestion(
          { text: text.trim(), email, history, human_pass: pass },
          {
            onStatus: status => updateBot(() => ({ status })),
            onDelta: delta => updateBot(msg => ({ text: msg.text + delta, status: undefined })),
            onReplace: replacement => updateBot(() => ({ text: replacement, status: undefined })),
          }
        );
      } catch (error) {
        if (!(error instanceof StreamUnavailableError)) throw error;
        // Streaming endpoint unreachable: fall back to the buffered /ask.
        console.warn('Streaming unavailable, falling back to /ask:', error.message);
        streamed = false;
        response = await chatAPI.sendQuestion({ text: text.trim(), email, history, human_pass: pass });
      }

      updateBot(() => ({
        text: response.answer,
        isStreaming: false,
        status: undefined,
        sources: response.sources,
        links: response.links,
        route: response.route,
        questionType: response.question_type,
        routeReason: response.route_reason,
        usage: response.usage,
        sourceDetails: response.source_details,
        followUps: response.follow_ups,
      }));
      if (response.quota) {
        setQuota(response.quota);
        saveQuota(response.quota);
      }
      trackEvent('question_answered', {
        route: response.route,
        estimated_usd: response.usage?.estimated_usd,
        total_tokens: response.usage?.total_tokens,
        success: response.success,
        streamed,
        follow_up: history.length > 0,
      });
      setLastError(response.success ? null : response.error || 'Unknown error occurred');
    } catch (error) {
      if (error instanceof CaptchaRequiredError) {
        // Drop the unanswered question and put it back in the input box,
        // so it can be sent again right after verifying.
        setMessages(prev => prev.filter(msg => msg.id !== botId && msg.id !== userMessage.id));
        setInputValue(text.trim());
        requireVerification(error.message);
        trackEvent('captcha_required');
        return;
      }
      console.error('Error sending message:', error);
      const errorMessage =
        error instanceof Error && error.message.startsWith('The answer was cut off')
          ? error.message
          : 'Sorry, I encountered an error while processing your question. Please try again later.';
      // Keep whatever was already streamed and append the error under it.
      updateBot(msg => ({
        text: msg.text ? `${msg.text}\n\n_${errorMessage}_` : errorMessage,
        isStreaming: false,
        status: undefined,
      }));
      setLastError(error instanceof Error ? error.message : 'Unknown error');
    } finally {
      setIsBotResponding(false);
    }
  };

  const handleClearChat = () => {
    setMessages([]);
    setShowExamples(true);
    setLastError(null);
    saveMessages([]);
    trackEvent('chat_cleared');
  };

  const handleRetryLastMessage = () => {
    if (messages.length > 0) {
      const lastUserMessage = [...messages].reverse().find(msg => !msg.isBot);
      if (lastUserMessage) {
        handleSendMessage(lastUserMessage.text);
      }
    }
  };

  const handleToggleCategory = (index: number) => {
    const newExpanded = new Set(expandedCategories);
    if (newExpanded.has(index)) {
      newExpanded.delete(index);
    } else {
      newExpanded.add(index);
    }
    setExpandedCategories(newExpanded);
  };

  const handleShowExamples = () => {
    setShowExamples(true);
  };

  const handleShowChat = () => {
    setShowExamples(false);
  };

  return {
    messages,
    inputValue,
    isBotResponding,
    showExamples,
    expandedCategories,
    lastError,
    email,
    quota,
    captchaConfig,
    needsVerification,
    captchaNotice,
    handleSetEmail,
    handleChangeEmail,
    messagesEndRef,
    lastBotMessageRef,
    setInputValue,
    handleSendMessage,
    handleClearChat,
    handleToggleCategory,
    handleShowExamples,
    handleShowChat,
    handleRetryLastMessage,
  };
}
