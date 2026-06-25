'use client';

// Shimmering placeholder rows shown while an /admin async load is in flight, instead of a blank gap.
export default function AdminSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="adminSkeleton" aria-hidden="true" data-testid="admin-skeleton">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="adminSkeletonRow" />
      ))}
    </div>
  );
}
