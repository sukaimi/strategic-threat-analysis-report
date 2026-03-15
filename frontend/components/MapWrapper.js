'use client';

import dynamic from 'next/dynamic';

const LeafletMap = dynamic(() => import('./Map'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex items-center justify-center bg-[#0a1628]">
      <div className="text-center">
        <div className="w-8 h-8 border-2 border-[#003A70] border-t-transparent rounded-full animate-spin mx-auto mb-3" />
        <span className="text-gray-500 font-mono text-sm tracking-widest">LOADING MAP</span>
      </div>
    </div>
  ),
});

export default function MapWrapper(props) {
  return <LeafletMap {...props} />;
}
