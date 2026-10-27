import { onBeforeUnmount, ref, watch, type Ref } from 'vue';

/**
 * Suivi du bas de défilement (chat, réflexion, terminaux) :
 *  - suit le contenu tant que l'utilisateur est en bas ;
 *  - suspend le suivi dès qu'il remonte (molette, clavier, glisser) ;
 *  - conserve sa position pendant les mises à jour ;
 *  - reprend lorsqu'il revient en bas.
 * Un seul ResizeObserver sur le contenu : aucun polling. Les éléments peuvent apparaître
 * ou disparaître (v-if) : les écouteurs suivent les références.
 */
export function useFollowScroll(container: Ref<HTMLElement | null>, content: Ref<HTMLElement | null>, threshold = 24) {
  const following = ref(true);
  let lastTop = 0;
  let programmatic = false;
  let frame = 0;
  const observer = new ResizeObserver(() => {
    if (!following.value || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      scrollToBottom();
    });
  });

  const atBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;

  function scrollToBottom(force = false) {
    const el = container.value;
    if (!el) return;
    if (force) following.value = true;
    if (!following.value) return;
    programmatic = true;
    el.scrollTop = el.scrollHeight;
    lastTop = el.scrollTop;
    requestAnimationFrame(() => (programmatic = false));
  }

  const onScroll = () => {
    const el = container.value;
    if (!el || programmatic) return;
    if (el.scrollTop < lastTop - 2) following.value = false;
    else if (atBottom(el)) following.value = true;
    lastTop = el.scrollTop;
  };
  // Remonter à la molette suspend immédiatement le suivi, même si le contenu grandit.
  const onWheel = (e: WheelEvent) => {
    if (e.deltaY < 0) following.value = false;
  };
  const onKey = (e: KeyboardEvent) => {
    if (['PageUp', 'ArrowUp', 'Home'].includes(e.key)) following.value = false;
  };

  watch(
    container,
    (el, old) => {
      if (old) {
        old.removeEventListener('scroll', onScroll);
        old.removeEventListener('wheel', onWheel);
        old.removeEventListener('keydown', onKey);
      }
      if (el) {
        el.addEventListener('scroll', onScroll, { passive: true });
        el.addEventListener('wheel', onWheel, { passive: true });
        el.addEventListener('keydown', onKey);
        lastTop = el.scrollTop;
        scrollToBottom(true);
      }
    },
    { immediate: true, flush: 'post' },
  );
  watch(
    content,
    (el, old) => {
      if (old) observer.unobserve(old);
      if (el) observer.observe(el);
    },
    { immediate: true, flush: 'post' },
  );

  onBeforeUnmount(() => {
    observer.disconnect();
    if (frame) cancelAnimationFrame(frame);
    const el = container.value;
    el?.removeEventListener('scroll', onScroll);
    el?.removeEventListener('wheel', onWheel);
    el?.removeEventListener('keydown', onKey);
  });

  return { following, scrollToBottom };
}
