'use client';

const TABS = [
  {
    id: 'map',
    label: 'Map',
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
        <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6" />
        <line x1="8" y1="2" x2="8" y2="18" />
        <line x1="16" y1="6" x2="16" y2="22" />
      </svg>
    ),
  },
  {
    id: 'threats',
    label: 'Threats',
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
        <path d="M12 9v4" />
        <path d="M10.363 3.591l-8.106 13.534a1.914 1.914 0 001.636 2.871h16.214a1.914 1.914 0 001.636-2.871L13.637 3.591a1.914 1.914 0 00-3.274 0z" />
        <path d="M12 17h.01" />
      </svg>
    ),
  },
  {
    id: 'alerts',
    label: 'Alerts',
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
        <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.73 21a2 2 0 01-3.46 0" />
      </svg>
    ),
  },
  {
    id: 'intel',
    label: 'Intel',
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
        <path d="M4 22h16a2 2 0 002-2V4a2 2 0 00-2-2H8a2 2 0 00-2 2v16a2 2 0 01-2 2zm0 0a2 2 0 01-2-2v-9c0-1.1.9-2 2-2h2" />
        <path d="M18 14h-8" />
        <path d="M15 18h-5" />
        <path d="M10 6h8v4h-8z" />
      </svg>
    ),
  },
  {
    id: 'status',
    label: 'Status',
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
        <rect x="3" y="3" width="7" height="7" />
        <rect x="14" y="3" width="7" height="7" />
        <rect x="14" y="14" width="7" height="7" />
        <rect x="3" y="14" width="7" height="7" />
      </svg>
    ),
  },
];

export default function BottomNav({ activeTab, onTabChange, alertCount = 0 }) {
  return (
    <nav className="lg:hidden fixed bottom-0 left-0 right-0 bg-saf-navy border-t border-blue-400/20 z-40 safe-area-bottom">
      <div className="flex items-center justify-around">
        {TABS.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              className={`flex flex-col items-center justify-center py-2 px-1 min-h-[56px] min-w-[56px] flex-1 transition-colors relative focus-visible:ring-2 focus-visible:ring-saf-airforce ${
                isActive
                  ? 'text-white'
                  : 'text-blue-300/60 hover:text-blue-200'
              }`}
            >
              <div className="relative">
                {tab.icon}
                {/* M17: Alert badge on bell icon */}
                {tab.id === 'alerts' && alertCount > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 bg-saf-red text-white text-[8px] font-bold min-w-[16px] h-4 rounded-full flex items-center justify-center px-1">
                    {alertCount > 99 ? '99+' : alertCount}
                  </span>
                )}
              </div>
              <span className={`text-[9px] uppercase tracking-wider mt-0.5 font-semibold ${
                isActive ? 'text-white' : ''
              }`}>
                {tab.label}
              </span>
              {isActive && (
                <div className="w-4 h-0.5 bg-saf-red rounded-full mt-0.5" />
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
