export default function Home() {
  return (
    <main className="min-h-dvh flex items-center justify-center bg-[#0a2540]">
      <div className="text-center space-y-6">
        <h1 className="text-5xl sm:text-6xl font-extrabold text-white tracking-tight">LevelStart</h1>
        <a
          href="/login"
          className="inline-block px-6 py-3 rounded-md bg-white text-black font-medium hover:bg-gray-100"
        >
          Sign In
        </a>
      </div>
    </main>
  );
}
