interface Card {
  id: string;
  title: string;
}

interface CardListProps {
  cards: Card[];
}

export const CardList = ({ cards, ...rest }: CardListProps & Record<string, unknown>) => {
  return (
    <ul className="cards" {...rest}>
      {cards.map((card) => (
        <li key={card.id} className="card">
          {card.title}
        </li>
      ))}
    </ul>
  );
};
