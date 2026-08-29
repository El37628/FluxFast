import Image from "next/image";
import styles from "./page.module.css";

export default function Home() {
  return (
    <main className={styles.main}>
      <Image src="/next.svg" alt="Next.js" width={180} height={38} priority />
      <h1>Create Next App</h1>
    </main>
  );
}
