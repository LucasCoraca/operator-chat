// Lightweight inline icons. All 16x16, 1.5px stroke, currentColor.
const Icon = ({ d, size = 16, fill = 'none', strokeWidth = 1.5, children, ...rest }) => (
  <svg
    width={size} height={size} viewBox="0 0 16 16"
    fill={fill} stroke="currentColor" strokeWidth={strokeWidth}
    strokeLinecap="round" strokeLinejoin="round"
    {...rest}
  >
    {d ? <path d={d} /> : children}
  </svg>
);

const IconPlus       = (p) => <Icon {...p} d="M8 3v10M3 8h10" />;
const IconSearch     = (p) => <Icon {...p}><circle cx="7" cy="7" r="4.25" /><path d="M10 10l3 3" /></Icon>;
const IconChat       = (p) => <Icon {...p} d="M3 4.5C3 3.67 3.67 3 4.5 3h7c.83 0 1.5.67 1.5 1.5v5c0 .83-.67 1.5-1.5 1.5H7L4 13.25V11h-.5A.5.5 0 0 1 3 10.5z" />;
const IconCheck      = (p) => <Icon {...p} d="M3.5 8.5l3 3 6-6.5" />;
const IconAlert      = (p) => <Icon {...p}><path d="M8 5v3.5" /><path d="M8 11v.01" /><circle cx="8" cy="8" r="6" /></Icon>;
const IconClock      = (p) => <Icon {...p}><circle cx="8" cy="8" r="6" /><path d="M8 5v3l2 1.5" /></Icon>;
const IconTerminal   = (p) => <Icon {...p}><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M5 7l1.5 1L5 9.5M8.5 10h2.5" /></Icon>;
const IconBrain      = (p) => <Icon {...p} d="M5.5 3.5C4.4 3.5 3.5 4.4 3.5 5.5c0 .5.2 1 .5 1.4-.6.4-1 1.1-1 1.9 0 .8.4 1.4 1 1.8-.3.4-.5.9-.5 1.4 0 1.1.9 2 2 2 .6 0 1.1-.3 1.5-.7M10.5 3.5c1.1 0 2 .9 2 2 0 .5-.2 1-.5 1.4.6.4 1 1.1 1 1.9 0 .8-.4 1.4-1 1.8.3.4.5.9.5 1.4 0 1.1-.9 2-2 2-.6 0-1.1-.3-1.5-.7M8 4v9" />;
const IconSend       = (p) => <Icon {...p} d="M3 8l10-5-3 11-2.5-4.5L3 8z" />;
const IconAttach     = (p) => <Icon {...p} d="M11.5 7.5l-4 4a2 2 0 1 1-2.8-2.8l5-5a3 3 0 0 1 4.3 4.3l-5 5" />;
const IconStop       = (p) => <Icon {...p}><rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" stroke="none" /></Icon>;
const IconRewind     = (p) => <Icon {...p}><path d="M3 8a5 5 0 1 1 1.5 3.5" /><path d="M3 5v3h3" /></Icon>;
const IconCopy       = (p) => <Icon {...p}><rect x="5.5" y="5.5" width="7" height="7" rx="1" /><path d="M3.5 10V4a1 1 0 0 1 1-1h6" /></Icon>;
const IconChevronD   = (p) => <Icon {...p} d="M4 6l4 4 4-4" />;
const IconChevronR   = (p) => <Icon {...p} d="M6 4l4 4-4 4" />;
const IconSettings   = (p) => <Icon {...p}><circle cx="8" cy="8" r="2" /><path d="M8 1.5v1.7M8 12.8v1.7M3.4 3.4l1.2 1.2M11.4 11.4l1.2 1.2M1.5 8h1.7M12.8 8h1.7M3.4 12.6l1.2-1.2M11.4 4.6l1.2-1.2" /></Icon>;
const IconExit       = (p) => <Icon {...p}><path d="M9 3h3v10H9" /><path d="M3 8h7M7.5 5.5L10 8l-2.5 2.5" /></Icon>;
const IconMemory     = (p) => <Icon {...p}><rect x="3" y="3" width="10" height="10" rx="1.5" /><path d="M3 6h10M3 10h10M6 3v10M10 3v10" /></Icon>;
const IconAgents     = (p) => <Icon {...p}><circle cx="6" cy="6.5" r="2" /><circle cx="11" cy="6.5" r="2" /><path d="M3 12.5c.5-1.5 1.7-2.5 3-2.5s2.5 1 3 2.5M8 12.5c.5-1.5 1.7-2.5 3-2.5s2.5 1 3 2.5" /></Icon>;
const IconTasks      = (p) => <Icon {...p}><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M5 6.5l1 1 2-2M5 10.5l1 1 2-2M9.5 6.5h2.5M9.5 10.5h2.5" /></Icon>;
const IconTools      = (p) => <Icon {...p} d="M11 2.5l2.5 2.5-3 3-2.5-2.5 3-3zM4 9l3 3-3.5 1.5L2 12.5 4 9z" />;
const IconKeyboard   = (p) => <Icon {...p}><rect x="2" y="4.5" width="12" height="7" rx="1.5" /><path d="M4.5 7h.01M7 7h.01M9.5 7h.01M12 7h.01M5 9.5h6" /></Icon>;
const IconBolt       = (p) => <Icon {...p} d="M9 2L4 9h3l-1 5 5-7H8l1-5z" />;
const IconLogo       = (p) => <Icon {...p} size={p.size || 20}><circle cx="8" cy="8" r="6" stroke="currentColor" /><path d="M5.5 8.5l1.7 1.7L11 6.4" stroke="currentColor" /></Icon>;

window.Icons = {
  IconPlus, IconSearch, IconChat, IconCheck, IconAlert, IconClock, IconTerminal,
  IconBrain, IconSend, IconAttach, IconStop, IconRewind, IconCopy, IconChevronD,
  IconChevronR, IconSettings, IconExit, IconMemory, IconAgents, IconTasks,
  IconTools, IconKeyboard, IconBolt, IconLogo,
};
