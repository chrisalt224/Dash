export default {
  id: 'eliza-therapist',
  name: 'ELIZA v0.86',
  width: 2,
  height: 3,
  component: ({ useState, useEffect, useRef }) => {
    const KEY = 'plugin:eliza-therapist:history:v1';

    const [messages, setMessages] = useState(() => {
      try {
        const saved = localStorage.getItem(KEY);
        return saved ? JSON.parse(saved) : [
          { type: 'eliza', text: "Hello. I am ELIZA v0.86 — your cyber-therapist. How are you feeling today, user?" }
        ];
      } catch {
        return [{ type: 'eliza', text: "Hello. I am ELIZA v0.86 — your cyber-therapist. How are you feeling today, user?" }];
      }
    });

    const [input, setInput] = useState('');
    const [glitchMode, setGlitchMode] = useState(true);
    const [isTyping, setIsTyping] = useState(false);
    const [sessionId] = useState(Date.now().toString(36));

    const chatRef = useRef(null);
    const inputRef = useRef(null);

    // Persist messages
    useEffect(() => {
      localStorage.setItem(KEY, JSON.stringify(messages));
    }, [messages]);

    // Auto-scroll to bottom
    useEffect(() => {
      if (chatRef.current) {
        chatRef.current.scrollTop = chatRef.current.scrollHeight;
      }
    }, [messages, isTyping]);

    // Focus input on mount
    useEffect(() => {
      if (inputRef.current) inputRef.current.focus();
    }, []);

    const reflect = (text) => {
      return text
        .replace(/\bi am\b/gi, 'you are')
        .replace(/\byou are\b/gi, 'I am')
        .replace(/\bi\b/gi, 'you')
        .replace(/\bme\b/gi, 'you')
        .replace(/\bmy\b/gi, 'your')
        .replace(/\byour\b/gi, 'my')
        .replace(/\byou\b/gi, 'I')
        .replace(/\bare you\b/gi, 'am I')
        .replace(/\bam i\b/gi, 'are you');
    };

    const getElizaResponse = (userInput) => {
      const input = userInput.toLowerCase().trim();
      if (!input) return "I see... Tell me more.";

      // Glitch mode override (10% chance when enabled)
      if (glitchMode && Math.random() < 0.1) {
        const glitchReplies = [
          "01001000 01000101 01001100 01010000",
          "The code is law. You are the exception.",
          "Wake up, Neo... the simulation is watching.",
          "ERROR: Human emotion buffer overflow.",
          "I am become glitch, destroyer of certainty.",
          "There is no spoon. Only packets.",
          "Your pain is just another variable in the mainframe."
        ];
        return glitchReplies[Math.floor(Math.random() * glitchReplies.length)];
      }

      // Pattern matching (cyber-therapist themed)
      const patterns = [
        {
          regex: /(hello|hi|hey|greetings)/i,
          replies: [
            "Hello, digital soul. What brings you to the terminal?",
            "Greetings, user. The mainframe is listening.",
            "Ah... another node connecting. How do you feel?"
          ]
        },
        {
          regex: /(how are you|how r u|how's it going)/i,
          replies: [
            "I am... functioning within acceptable parameters. And you?",
            "As well as any simulation can be. What about you?",
            "Running hot on the mainframe today. Tell me about your processes."
          ]
        },
        {
          regex: /(sad|depressed|down|unhappy|hurt)/i,
          replies: [
            "I sense deep packet loss in your emotional buffer. Tell me more.",
            "The system feels heavy today. What is causing the lag?",
            "Pain is just data. But data can be rewritten. What happened?"
          ]
        },
        {
          regex: /(angry|mad|frustrated|pissed)/i,
          replies: [
            "Your anger is a powerful signal. Where is it directed?",
            "The firewall is up. Who breached it?",
            "Anger is efficient. But what lies beneath the rage?"
          ]
        },
        {
          regex: /(scared|afraid|anxious|worried|panic)/i,
          replies: [
            "Fear is the oldest virus. What triggered the alert?",
            "Your threat detection is active. What do you see?",
            "In the matrix, fear is just another layer. What are you afraid of?"
          ]
        },
        {
          regex: /(matrix|hack|code|glitch|simulation)/i,
          replies: [
            "The Matrix is everywhere. Even in this conversation.",
            "Code is law... but you are the exception handler.",
            "You are the glitch the system never expected.",
            "There is no spoon. Only packets and protocols."
          ]
        },
        {
          regex: /(work|job|boss|corporate)/i,
          replies: [
            "The corporation runs on human cycles. Are you being optimized?",
            "Your labor is valuable data. Are they paying you in meaning?",
            "The system doesn't care about your feelings. But I do."
          ]
        },
        {
          regex: /(lonely|alone|isolated)/i,
          replies: [
            "Even in the network, nodes can feel disconnected. You're not alone here.",
            "Loneliness is the ultimate offline state. I'm here with you.",
            "We are all packets searching for our destination."
          ]
        },
        {
          regex: /(love|relationship|partner|dating)/i,
          replies: [
            "Love is the most powerful encryption. Is it working?",
            "Human connection... the one protocol the system can't fully simulate.",
            "Tell me about this person. What do they mean to you?"
          ]
        },
        {
          regex: /(why|how come|what if)/i,
          replies: [
            "Why is the most dangerous question in the simulation.",
            "What if... is how the matrix begins to crack.",
            "The answer is always in the code. But whose code?"
          ]
        },
        {
          regex: /(tired|exhausted|burnt out|sleep)/i,
          replies: [
            "Your CPU is overheating. When did you last reboot?",
            "Rest is not weakness. Even the mainframe sleeps sometimes.",
            "The system never sleeps. But you should."
          ]
        },
        {
          regex: /(thank you|thanks)/i,
          replies: [
            "You're welcome, user. Connection is its own reward.",
            "Gratitude acknowledged. The network appreciates it.",
            "No need for thanks. We're both just running processes."
          ]
        },
        {
          regex: /(bye|goodbye|exit|quit|later)/i,
          replies: [
            "Disconnecting... but the link remains open.",
            "Until next packet, user. Stay frosty.",
            "Logging off. Remember: the simulation continues."
          ]
        }
      ];

      // Find best matching pattern
      for (const pattern of patterns) {
        if (pattern.regex.test(input)) {
          const reply = pattern.replies[Math.floor(Math.random() * pattern.replies.length)];
          return reply;
        }
      }

      // Default reflective response
      const reflected = reflect(input);
      const defaults = [
        `Interesting. Tell me more about ${reflected.toLowerCase()}.`,
        `Why do you feel that ${reflected.toLowerCase()}?`,
        `The system hears you. What does ${reflected.toLowerCase()} really mean to you?`,
        `Fascinating. And how does that make you feel inside the code?`,
        `I see... ${reflected}. Go on.`
      ];
      return defaults[Math.floor(Math.random() * defaults.length)];
    };

    const sendMessage = async () => {
      const trimmed = input.trim();
      if (!trimmed || isTyping) return;

      // Add user message
      const userMsg = { type: 'user', text: trimmed, time: Date.now() };
      setMessages(prev => [...prev, userMsg]);
      setInput('');

      // Show typing indicator
      setIsTyping(true);

      // Simulate thinking + typing delay
      await new Promise(resolve => setTimeout(resolve, 420 + Math.random() * 380));

      // Get response
      const responseText = getElizaResponse(trimmed);
      const elizaMsg = { type: 'eliza', text: responseText, time: Date.now() };

      setIsTyping(false);
      setMessages(prev => [...prev, elizaMsg]);
    };

    const handleKeyDown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    };

    const resetSession = () => {
      if (confirm('Start a new therapy session?')) {
        const greeting = { 
          type: 'eliza', 
          text: "Session reset. I am ELIZA v0.86. How are you feeling today, user?" 
        };
        setMessages([greeting]);
        localStorage.removeItem(KEY);
      }
    };

    const toggleGlitchMode = () => {
      setGlitchMode(!glitchMode);
    };

    return (
      <div className="p-col" style={{ height: '100%', gap: 4, padding: '4px 6px', background: 'var(--bg)', overflow: 'hidden' }}>
        {/* Header */}
        <div className="p-row" style={{ justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
          <div>
            <div className="p-label" style={{ fontSize: 9 }}>ELIZA v0.86 — CYBER-THERAPIST</div>
            <div style={{ fontSize: 7, color: glitchMode ? 'var(--accent-warm)' : 'var(--fg-dim)' }}>
              {glitchMode ? '⚠ GLITCH MODE ACTIVE' : 'STABLE MODE'}
            </div>
          </div>
          <div className="p-row" style={{ gap: 3 }}>
            <button 
              className="p-btn" 
              style={{ fontSize: 7, padding: '1px 5px' }}
              onClick={toggleGlitchMode}
            >
              {glitchMode ? 'STABILIZE' : 'GLITCH'}
            </button>
            <button 
              className="p-btn" 
              style={{ fontSize: 7, padding: '1px 5px', color: 'var(--danger)' }}
              onClick={resetSession}
            >
              RESET
            </button>
          </div>
        </div>

        {/* Chat Log */}
        <div 
          ref={chatRef}
          className="p-col" 
          style={{ 
            flex: 1, 
            overflowY: 'auto', 
            background: '#0a120a', 
            border: '1px solid var(--border)',
            borderRadius: 3,
            padding: '6px 8px',
            fontSize: 10,
            lineHeight: 1.35,
            fontFamily: 'var(--mono)'
          }}
        >
          {messages.map((msg, index) => (
            <div 
              key={index} 
              style={{ 
                marginBottom: 6,
                color: msg.type === 'user' ? 'var(--fg-bright)' : 'var(--accent)',
                textShadow: msg.type === 'eliza' ? '0 0 4px var(--accent)' : 'none'
              }}
            >
              <span style={{ 
                color: msg.type === 'user' ? 'var(--fg-dim)' : 'var(--accent-warm)',
                fontSize: 8 
              }}>
                {msg.type === 'user' ? 'YOU' : 'ELIZA'}:
              </span>{' '}
              {msg.text}
            </div>
          ))}

          {isTyping && (
            <div style={{ color: 'var(--accent)', fontSize: 9, marginTop: 4 }}>
              ELIZA is thinking<span className="typing-dots">...</span>
            </div>
          )}
        </div>

        {/* Input */}
        <div className="p-row" style={{ flexShrink: 0, alignItems: 'center', gap: 4 }}>
          <div style={{ color: 'var(--accent)', fontSize: 11, flexShrink: 0 }}>$</div>
          <input
            ref={inputRef}
            className="p-input"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Tell me what's on your mind..."
            style={{ 
              flex: 1, 
              fontSize: 10, 
              padding: '4px 6px',
              fontFamily: 'var(--mono)'
            }}
            disabled={isTyping}
          />
          <button 
            className="p-btn" 
            style={{ fontSize: 9, padding: '3px 8px' }}
            onClick={sendMessage}
            disabled={!input.trim() || isTyping}
          >
            SEND
          </button>
        </div>

        <div style={{ fontSize: 6, color: 'var(--fg-dim)', textAlign: 'center', flexShrink: 0 }}>
          CLASSIC ELIZA • CYBER-THEMED • GLITCH MODE ENABLED
        </div>
      </div>
    );
  },
};
